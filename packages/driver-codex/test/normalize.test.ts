import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { CodexNormalizer } from "../src/normalize.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface Line {
  method: string;
  params: unknown;
}

function load(name: string): Line[] {
  return readFileSync(join(fixtures, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
}

function run(name: string): { events: NormalizedEvent[]; normalizer: CodexNormalizer } {
  const normalizer = new CodexNormalizer();
  const events: NormalizedEvent[] = [];
  for (const line of load(name)) events.push(...normalizer.next(line.method, line.params));
  return { events, normalizer };
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

describe("normalizer over app-server fixtures", () => {
  it("basic-turn: session, streamed text, one command round trip, usage and settled", () => {
    const { events } = run("basic-turn");
    expect(kinds(events)).toEqual([
      "session",
      "activity:tool", // ls -1 running
      "activity:tool", // ls -1 completed
      "assistant.delta",
      "assistant.delta",
      "usage",
      "settled",
    ]);

    const first = events[0];
    if (first?.type !== "session") throw new Error("unreachable");
    expect(first.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);

    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools[0]).toMatchObject({ toolName: "Bash", status: "running", toolUseId: "item_cmd" });
    expect(tools[0]?.input).toEqual({ command: "ls -1", cwd: "/tmp/repo" });
    expect(tools[1]).toMatchObject({ status: "ok", output: "hello.txt\n", durationMs: 42 });

    // both deltas share the item id as their message key; reasoning never leaks in
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event] : []));
    expect(deltas.map((delta) => delta.messageKey)).toEqual(["item_msg", "item_msg"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe("There is one file.");

    const usage = events.find((event) => event.type === "usage");
    if (usage?.type !== "usage") throw new Error("unreachable");
    expect(usage.usage).toEqual({ inputTokens: 900, outputTokens: 300, cacheReadTokens: 700, cacheWriteTokens: 50 });
    expect(usage.contextUsage).toEqual({ used: 5200, window: 272000 });

    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("basic-turn: outputDelta fills in when the item carries no aggregated output", () => {
    const normalizer = new CodexNormalizer();
    const lines = load("basic-turn").map((line) => {
      if (line.method !== "item/completed") return line;
      const params = line.params as { item: { type: string; aggregatedOutput?: string | null } };
      if (params.item.type === "commandExecution") params.item.aggregatedOutput = null;
      return line;
    });
    const events = lines.flatMap((line) => normalizer.next(line.method, line.params));
    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools.at(-1)?.output).toBe("hello.txt\n");
  });

  it("plan-turn: plan item becomes plan.proposed, turn plan becomes plan.progress", () => {
    const { events } = run("plan-turn");
    expect(kinds(events)).toEqual(["session", "plan.progress", "plan.proposed", "settled"]);

    const progress = events.find((event) => event.type === "plan.progress");
    if (progress?.type !== "plan.progress") throw new Error("unreachable");
    expect(progress.steps).toEqual([
      { text: "Add a README", status: "in_progress" },
      { text: "Link it from the docs index", status: "pending" },
    ]);

    const plan = events.find((event) => event.type === "plan.proposed");
    if (plan?.type !== "plan.proposed") throw new Error("unreachable");
    expect(plan.markdown).toContain("1. Add a README");
  });

  it("plan-turn: falls back to accumulated deltas when the plan item carries no text", () => {
    const normalizer = new CodexNormalizer();
    const events = load("plan-turn").flatMap((line) => {
      if (line.method === "item/completed") (line.params as { item: { text: string } }).item.text = "";
      return normalizer.next(line.method, line.params);
    });
    const plan = events.find((event) => event.type === "plan.proposed");
    if (plan?.type !== "plan.proposed") throw new Error("unreachable");
    expect(plan.markdown).toBe("## Plan\n1. Add a README\n2. Link it from the docs index\n");
  });

  it("subagent-turn: collab children get child rows and stamp their own activities", () => {
    const { events, normalizer } = run("subagent-turn");
    expect(kinds(events)).toEqual([
      "session",
      "activity:child", // spawnAgent running
      "activity:tool", // rg inside the child thread
      "activity:child", // spawnAgent completed
      "assistant.delta", // main-loop text only
      "activity:info", // model rerouted
      "settled",
    ]);

    const children = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "child" ? [event.activity] : []));
    expect(children[0]).toMatchObject({ childKey: "01a05503-4000-7000-8000-000000000001", name: "spawnAgent", status: "running", description: "Audit the parser" });
    expect(children[1]).toMatchObject({ status: "done", summary: "The parser handles 3 cases." });

    const tool = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []))[0];
    expect(tool?.parentToolUseId).toBe("item_collab");

    // the child's own prose stays on the child row, not in the thread's assistant message
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : []));
    expect(deltas).toEqual(["Done."]);
    expect(normalizer.unknownCount).toBe(1);
  });

  it("edit-turn: patchUpdated feeds the diff, retries are info, interrupted settles as interrupted", () => {
    const { events, normalizer } = run("edit-turn");
    expect(kinds(events)).toEqual(["session", "activity:tool", "activity:tool", "activity:info", "settled"]);

    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools[0]).toMatchObject({ toolName: "Edit", status: "running" });
    expect(tools[0]?.input).toEqual({ changes: [{ path: "/tmp/repo/README.md", kind: "add" }] });
    expect(tools[1]?.output).toContain("+# Repo");
    expect(normalizer.patchFor("item_patch")).toContain("+# Repo");

    const info = events.find((event) => event.type === "activity" && event.activity.kind === "info");
    if (info?.type !== "activity" || info.activity.kind !== "info") throw new Error("unreachable");
    expect(info.activity.text).toBe("Reconnecting... 1/5");

    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("error-turn (recorded live): the 401 failure settles as error with the server's message", () => {
    const { events } = run("error-turn");
    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error("unreachable");
    expect(settled.status).toBe("error");
    expect(settled.error).toContain("401 Unauthorized");

    // retries stay info rows; only the final, non-retrying error is an error row
    const errors = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "error" ? [event.activity] : []));
    expect(errors).toHaveLength(1);
    expect(events[0]?.type).toBe("session");
  });

  it("ignores notifications for unrelated threads and never throws on unknown frames", () => {
    const normalizer = new CodexNormalizer({ threadId: "mine" });
    expect(normalizer.next("item/agentMessage/delta", { threadId: "other", itemId: "x", delta: "nope" })).toEqual([]);
    expect(normalizer.next("brand/new", { threadId: "mine" })).toEqual([]);
    expect(normalizer.next("item/agentMessage/delta", { threadId: "mine", itemId: "x", delta: "yes" })).toEqual([
      { type: "assistant.delta", messageKey: "x", delta: "yes" },
    ]);
  });

  it("settles as interrupted once marked, whatever the server reports", () => {
    const normalizer = new CodexNormalizer();
    normalizer.markInterrupted();
    expect(normalizer.next("turn/completed", { threadId: "t", turn: { id: "u", status: "completed" } })).toEqual([{ type: "settled", status: "interrupted" }]);
  });
});
