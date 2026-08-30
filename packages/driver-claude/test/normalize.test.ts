import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { ClaudeNormalizer } from "../src/normalize.ts";
import type { ClaudeMessage } from "../src/sdk-shapes.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): ClaudeMessage[] {
  return readFileSync(join(fixtures, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaudeMessage);
}

function run(name: string, partialMessages = true): { events: NormalizedEvent[]; unknown: number } {
  const normalizer = new ClaudeNormalizer({ partialMessages });
  const events: NormalizedEvent[] = [];
  for (const message of load(name)) events.push(...normalizer.next(message));
  return { events, unknown: normalizer.unknownCount };
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

describe("normalizer over recorded fixtures", () => {
  it("basic-turn: session, streamed text, one tool round trip, usage and settled", () => {
    const { events } = run("basic-turn");
    const first = events[0];
    expect(first?.type).toBe("session");
    if (first?.type !== "session") throw new Error("unreachable");
    expect(first.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.model).toBeTruthy();

    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.length).toBeGreaterThan(0);
    // every delta of one streamed block shares a stable key
    expect(new Set(deltas.map((delta) => delta.messageKey)).size).toBeLessThanOrEqual(2);

    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools.map((tool) => tool.toolName)).toContain("Bash");
    expect(tools.at(-1)?.status).toBe("ok");
    expect(tools.at(-1)?.toolUseId).toBe(tools[0]?.toolUseId);

    expect(kinds(events).at(-1)).toBe("settled");
    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error("unreachable");
    expect(settled.status).toBe("completed");

    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    if (usage[0]?.type !== "usage") throw new Error("unreachable");
    expect(usage[0].usage?.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage[0].usage?.costUsd).toBeGreaterThan(0);
  });

  it("plan-turn: ExitPlanMode is a tool call whose denial does not fail the turn", () => {
    const { events } = run("plan-turn");
    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    const exitPlan = tools.filter((tool) => tool.toolName === "ExitPlanMode");
    expect(exitPlan.length).toBe(2); // running, then the denial result
    expect(exitPlan[1]?.status).toBe("error");
    expect(exitPlan[1]?.output).toContain("Plan recorded in Tide");

    // thinking deltas never reach the assistant message
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : []));
    expect(deltas.join("")).not.toContain("signature");

    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error("unreachable");
    expect(settled.status).toBe("completed");
  });

  it("synthetic-subagent: exact event sequence", () => {
    const { events, unknown } = run("synthetic-subagent");
    expect(kinds(events)).toEqual([
      "session",
      "activity:tool", // TodoWrite running
      "plan.progress",
      "activity:tool", // TodoWrite ok
      "activity:tool", // Task running
      "activity:child", // child opened
      "activity:tool", // Grep inside the subagent
      "activity:tool", // Grep result
      "activity:tool", // Task result
      "activity:child", // child done
      "activity:info", // permission_denied
      "activity:info", // api_retry
      "assistant.delta",
      "usage",
      "settled",
    ]);

    const plan = events.find((event) => event.type === "plan.progress");
    if (plan?.type !== "plan.progress") throw new Error("unreachable");
    expect(plan.steps).toEqual([
      { text: "Read the code", status: "in_progress" },
      { text: "Write the test", status: "pending" },
    ]);

    const child = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "child" ? [event.activity] : []));
    expect(child[0]).toMatchObject({ childKey: "toolu_task", name: "Audit the parser", status: "running", description: "Explore" });
    expect(child[1]).toMatchObject({ childKey: "toolu_task", status: "done", summary: "The parser handles 3 cases." });

    const subagentTool = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" && event.activity.toolName === "Grep" ? [event.activity] : []));
    expect(subagentTool[0]?.parentToolUseId).toBe("toolu_task");

    // subagent text is not streamed into the main message; only the main-loop delta is
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event] : []));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.delta).toBe("Done.");
    expect(deltas[0]?.messageKey).toBe("msg_04-1");

    // one rate-limit-free stream: only the genuinely unknown frame is counted
    expect(unknown).toBe(1);
  });

  it("falls back to whole-text deltas when partial messages are off", () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: false });
    const events = normalizer.next({
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "u1",
      message: { id: "msg_x", content: [{ type: "text", text: "hello" }] },
    } as ClaudeMessage);
    expect(events).toEqual([{ type: "assistant.delta", messageKey: "msg_x-0", delta: "hello" }]);
  });

  it("settles as interrupted once marked, and never throws on unknown frames", () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: true });
    normalizer.markInterrupted();
    expect(normalizer.next({ type: "totally_new" } as ClaudeMessage)).toEqual([]);
    const events = normalizer.next({
      type: "result",
      subtype: "success",
      session_id: "s",
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 2 },
    } as ClaudeMessage);
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });
});
