import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { OpencodeNormalizer } from "../src/normalize.ts";
import type { OpencodeEvent } from "../src/wire.ts";

/**
 * `basic-turn` and `tool-permission` are recorded from a real `opencode serve` 1.1.36
 * (scripts/record-fixture.ts). `plan-turn` is hand-written from the same server's OpenAPI
 * schemas: the recorder hit a provider rate limit before the plan scenario ran, and the
 * shapes it covers (todo.updated, question.asked, plan_exit, subagent task tool, a text
 * part without `delta`, a foreign session, an unknown event) are exactly the ones the two
 * recordings do not contain.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): OpencodeEvent[] {
  return readFileSync(join(fixtures, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as OpencodeEvent);
}

function sessionIdOf(events: OpencodeEvent[]): string {
  for (const event of events) {
    const id = (event.properties as { sessionID?: string } | undefined)?.sessionID;
    if (id !== undefined) return id;
  }
  throw new Error("fixture has no session id");
}

function run(name: string, options: { agent?: string; contextWindow?: number } = {}): { events: NormalizedEvent[]; unknown: number } {
  const raw = load(name);
  const normalizer = new OpencodeNormalizer({
    sessionId: sessionIdOf(raw),
    agent: options.agent ?? "build",
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
  });
  const events: NormalizedEvent[] = [];
  for (const event of raw) events.push(...normalizer.next(event));
  return { events, unknown: normalizer.unknownCount };
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

describe("normalizer over recorded opencode fixtures", () => {
  it("basic-turn: streamed text, then usage and a single completed settle", () => {
    const { events, unknown } = run("basic-turn", { contextWindow: 200_000 });
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((delta) => delta.delta).join("")).toBe("opencode-ok");
    expect(new Set(deltas.map((delta) => delta.messageKey)).size).toBe(1);

    expect(kinds(events).at(-1)).toBe("settled");
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });

    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    if (usage[0]?.type !== "usage") throw new Error("unreachable");
    expect(usage[0].usage?.inputTokens).toBe(297);
    expect(usage[0].usage?.outputTokens).toBe(5);
    expect(usage[0].usage?.cacheReadTokens).toBe(15_104);
    expect(usage[0].contextUsage).toEqual({ used: 297 + 15_104 + 5, window: 200_000 });
    // no plan proposal from a build-agent turn
    expect(events.some((event) => event.type === "plan.proposed")).toBe(false);
    expect(unknown).toBe(0);
  });

  it("tool-permission: one tool round trip and the approval that gated it", () => {
    const { events } = run("tool-permission");
    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolName: "bash", status: "running", input: { command: "echo hello-from-opencode" } });
    expect(tools[1]).toMatchObject({ toolName: "bash", status: "ok", output: "hello-from-opencode\n" });
    expect(tools[1]?.toolUseId).toBe(tools[0]?.toolUseId);

    const approvals = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "approval" ? [event.activity] : []));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolName: "bash", status: "pending", input: { command: "echo hello-from-opencode" } });
    expect(approvals[0]?.requestId).toMatch(/^per_/);
    expect(approvals[0]?.description).toBe("echo hello-from-opencode");

    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("plan-turn: exact event sequence for todos, subagents, questions and the plan", () => {
    const { events, unknown } = run("plan-turn", { agent: "plan", contextWindow: 100_000 });
    expect(kinds(events)).toEqual([
      "plan.progress",
      "activity:info", // a provider retry, reported once per attempt
      "activity:tool", // task running
      "activity:child", // subagent opened
      "activity:tool", // task completed
      "activity:child", // subagent done
      "activity:user-input",
      "assistant.delta",
      "assistant.delta",
      "assistant.delta", // a build that omits `delta` still yields the increment
      "plan.proposed", // plan_exit is captured, never allowed
      "plan.proposed", // and again when the plan message completes
      "usage",
      "settled",
    ]);

    const retry = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" ? [event.activity.text] : []));
    expect(retry).toEqual(["Retrying (attempt 1): Error from provider (Console): Rate limit exceeded. Please try again later."]);

    const progress = events.find((event) => event.type === "plan.progress");
    if (progress?.type !== "plan.progress") throw new Error("unreachable");
    expect(progress.steps).toEqual([
      { text: "Read the code", status: "in_progress" },
      { text: "Draft the plan", status: "pending" },
      { text: "Skip this", status: "pending" },
    ]);

    const child = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "child" ? [event.activity] : []));
    expect(child[0]).toMatchObject({ childKey: "prt_task", name: "Audit the parser", status: "running" });
    expect(child[1]).toMatchObject({ childKey: "prt_task", status: "done", summary: "The parser handles 3 cases." });

    const question = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "user-input" ? [event.activity] : []))[0];
    expect(question?.questions[0]).toEqual({
      id: "q0",
      text: "Which README style?",
      options: [
        { label: "Minimal", description: "Just usage" },
        { label: "Full", description: "Everything" },
      ],
    });

    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : []));
    expect(deltas.join("")).toBe("# Plan\n- add README\n- link it\n");
    // synthetic parts and other sessions never reach the transcript
    expect(deltas.join("")).not.toContain("synthetic");
    expect(deltas.join("")).not.toContain("leak");

    const plans = events.flatMap((event) => (event.type === "plan.proposed" ? [event.markdown] : []));
    expect(plans[0]).toBe("# Plan\n- add README\n- link it\n");
    expect(plans[1]).toBe(plans[0]);
    // the plan_exit permission is not offered to the user as an approval
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(false);

    const usage = events.find((event) => event.type === "usage");
    if (usage?.type !== "usage") throw new Error("unreachable");
    expect(usage.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.011 });
    expect(usage.contextUsage).toEqual({ used: 2400, window: 100_000 });
    expect(unknown).toBe(1); // only the deliberately unknown frame
  });

  it("settles as interrupted once marked and reports session errors", () => {
    const interrupted = new OpencodeNormalizer({ sessionId: "s", agent: "build" });
    interrupted.markInterrupted();
    expect(interrupted.next({ type: "session.idle", properties: { sessionID: "s" } })).toEqual([{ type: "settled", status: "interrupted" }]);
    expect(interrupted.next({ type: "session.idle", properties: { sessionID: "s" } })).toEqual([]);

    const failed = new OpencodeNormalizer({ sessionId: "s", agent: "build" });
    expect(failed.next({ type: "session.error", properties: { sessionID: "s", error: { name: "ProviderAuthError", data: { message: "no key" } } } })).toEqual([
      { type: "settled", status: "error", error: "ProviderAuthError: no key" },
    ]);

    const aborted = new OpencodeNormalizer({ sessionId: "s", agent: "build" });
    expect(aborted.next({ type: "session.error", properties: { sessionID: "s", error: { name: "MessageAbortedError", data: { message: "aborted" } } } })).toEqual([
      { type: "settled", status: "interrupted" },
    ]);
  });
});
