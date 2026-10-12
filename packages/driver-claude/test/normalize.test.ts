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

    const usage = events.filter((event) => event.type === "usage" && event.usage !== undefined);
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
      "assistant.reasoning",
      "assistant.delta",
      "activity:info", // pass-through of the unmodelled frame
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
    expect(deltas[0]?.messageKey).toBe("msg_04");

    // one rate-limit-free stream: only the genuinely unknown frame is counted, and it is
    // surfaced generically rather than dropped (CLAUDE.md §1a)
    expect(unknown).toBe(1);
    const passthrough = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" && event.activity.payload !== undefined ? [event.activity] : []));
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0]?.text).toBe("claude: future_message_kind_we_do_not_know/whatever");
    expect(passthrough[0]?.payload).toMatchObject({ type: "future_message_kind_we_do_not_know" });
  });

  it("synthetic-reasoning: thinking shares the message key with the text that follows", () => {
    const { events, unknown } = run("synthetic-reasoning");
    const reasoning = events.flatMap((event) => (event.type === "assistant.reasoning" ? [event] : []));
    expect(reasoning.map((event) => event.delta).join("")).toBe("Let me check the parser.");
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event] : []));
    expect(deltas).toHaveLength(1);
    // one message: reasoning and text merge because the key is the message id, not the block
    expect(new Set([...reasoning, ...deltas].map((event) => event.messageKey))).toEqual(new Set(["msg_r1"]));

    // background tasks become a child row keyed by the spawning tool call
    const children = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "child" ? [event.activity] : []));
    expect(children).toEqual([
      { kind: "child", childKey: "toolu_bg", name: "Watch the build", status: "running", description: "Explore" },
      { kind: "child", childKey: "toolu_bg", name: "Watch the build", status: "running", description: "Explore", summary: "Running Bash" },
      { kind: "child", childKey: "toolu_bg", name: "Watch the build", status: "done", description: "Explore" },
    ]);

    // `status`/`thinking_tokens` and the ambient task are the allowlisted silent drops;
    // only the genuinely new system subtype is passed through
    const info = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" ? [event.activity] : []));
    expect(info.map((activity) => activity.text)).toEqual(["claude: system/brand_new_thing"]);
    expect(unknown).toBe(1);
  });

  it("surfaces whole thinking blocks when partial messages are off", () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: false });
    const events = normalizer.next({
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "u1",
      message: { id: "msg_t", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "hello" }] },
    } as ClaudeMessage);
    expect(events).toEqual([
      { type: "assistant.reasoning", messageKey: "msg_t", delta: "hmm" },
      { type: "assistant.delta", messageKey: "msg_t", delta: "hello" },
    ]);
  });

  it("falls back to whole-text deltas when partial messages are off", () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: false });
    const events = normalizer.next({
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "u1",
      message: { id: "msg_x", content: [{ type: "text", text: "hello" }] },
    } as ClaudeMessage);
    expect(events).toEqual([{ type: "assistant.delta", messageKey: "msg_x", delta: "hello" }]);
  });

  it("settles as interrupted once marked, and never throws on unknown frames", () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: true });
    normalizer.markInterrupted();
    expect(normalizer.next({ type: "totally_new" } as ClaudeMessage)).toEqual([
      { type: "activity", activity: { kind: "info", text: "claude: totally_new", payload: { type: "totally_new" } } },
    ]);
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

describe("silent frames", () => {
  it("drops command_lifecycle bookkeeping without a pass-through row", () => {
    const n = new ClaudeNormalizer({ partialMessages: true });
    const before = n.unknownCount;
    expect(n.next({ type: "command_lifecycle", uuid: "u1", subtype: "started", session_id: "s" } as never)).toEqual([]);
    expect(n.unknownCount).toBe(before);
  });
});

describe("usage deltas (cumulative query() totals)", () => {
  const result = (input: number, output: number, cost: number, extra: Record<string, unknown> = {}) =>
    ({ type: "result", subtype: "success", session_id: "s", is_error: false, total_cost_usd: cost, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: input * 10, cache_creation_input_tokens: 0 }, ...extra }) as ClaudeMessage;

  it("reports only each turn's own cost and tokens across two results in one session", () => {
    const n = new ClaudeNormalizer({ partialMessages: true });
    const first = n.next(result(100, 40, 0.5)).find((e) => e.type === "usage");
    const second = n.next(result(130, 90, 0.75)).find((e) => e.type === "usage");
    expect(first).toEqual({ type: "usage", usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.5 } });
    expect(second).toEqual({ type: "usage", usage: { inputTokens: 30, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0, costUsd: 0.25 } });
  });

  it("treats a counter that went backwards (fresh query) as a restart", () => {
    const n = new ClaudeNormalizer({ partialMessages: true });
    n.next(result(100, 40, 0.5));
    const again = n.next(result(10, 5, 0.1)).find((e) => e.type === "usage");
    expect(again).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 } });
  });

  it("surfaces resume_reason and startup_failure_reason as info rows", () => {
    const n = new ClaudeNormalizer({ partialMessages: true });
    const events = n.next(result(1, 1, 0.01, { resume_reason: "worker_restart", startup_failure_reason: "proxy_invalid", subtype: "error_during_execution", is_error: true }));
    const infos = events.filter((e) => e.type === "activity").map((e) => (e.type === "activity" && e.activity.kind === "info" ? e.activity.text : ""));
    expect(infos).toEqual(["Turn resumed after a restart (worker_restart)", "Claude Code failed to start: proxy_invalid"]);
  });
});

describe("rate_limit_event", () => {
  const frame = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info }) as ClaudeMessage;

  it("nominal frame feeds the gauge without a timeline row (live shape: unifiedWindows)", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 42 });
    const events = n.next(frame({ status: "allowed", resetsAt: 1788141000, rateLimitType: "five_hour", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.18, resetsAt: 1788141000 } } }));
    expect(events).toEqual([{ type: "usage", rateLimit: { status: "ok", remainingPct: 82, resetsAt: 1788141000000, overage: false, note: "five_hour 18% used", at: 42 } }]);
  });

  it("warning and rejected frames map to warning/limited and add an info row", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 1 });
    const warn = n.next(frame({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, isUsingOverage: true }));
    expect(warn[0]).toMatchObject({ type: "usage", rateLimit: { status: "warning", remainingPct: 10, overage: true } });
    expect(warn[1]).toMatchObject({ type: "activity", activity: { kind: "info", text: "Rate limit allowed_warning on seven_day (90% used)" } });
    const limited = n.next(frame({ status: "rejected" }));
    expect(limited[0]).toMatchObject({ rateLimit: { status: "limited" } });
  });
});
