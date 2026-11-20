import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { CodexNormalizer } from "../src/normalize.ts";

// Ids and item shapes from test/fixtures/subagent-turn.ndjson (codex-cli 0.170.0).
const MAIN = "01a1f087-8852-7493-9355-dee90c5e1fcf";
const MAIN_TURN = "01a1f087-8877-7503-95e2-ab514419422c";
const CHILD = "01a1f087-9c68-7122-bd49-90e1a77d7304";
const CHILD_TURN = "01a1f087-9c7b-73c2-a29f-d0f7b53c548c";

function subAgent(threadId: string, turnId: string, kind: string, agentThreadId: string, agentPath: string): Record<string, unknown> {
  return {
    threadId,
    turnId,
    item: { type: "subAgentActivity", model: null, reasoningEffort: null, id: `sa-${kind}-${agentThreadId}`, kind, agentThreadId, agentPath, startedAtMs: 1, completedAtMs: 1 },
  };
}

function collab(threadId: string, tool: string, receivers: string[]): Record<string, unknown> {
  return {
    threadId,
    turnId: CHILD_TURN,
    item: { type: "collabAgentToolCall", id: `call-${tool}`, tool, status: "completed", senderThreadId: threadId, receiverThreadIds: receivers, prompt: null, model: null, reasoningEffort: null, agentsStates: {}, startedAtMs: 1, completedAtMs: 2 },
  };
}

/** The parent's turn spawns CHILD, then something in CHILD's thread names the root thread. */
function run(n: CodexNormalizer, announce: boolean, rootMention: [string, unknown]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const feed = (method: string, params: unknown): void => {
    events.push(...n.next(method, params));
  };
  if (announce) feed("thread/started", { thread: { id: MAIN, parentThreadId: null, agentNickname: null } });
  feed("turn/started", { threadId: MAIN, turn: { id: MAIN_TURN, status: "inProgress", items: [] } });
  feed("item/completed", subAgent(MAIN, MAIN_TURN, "started", CHILD, "/root/return_format"));
  feed("turn/started", { threadId: CHILD, turn: { id: CHILD_TURN, status: "inProgress", items: [] } });
  feed(...rootMention);
  feed("turn/completed", { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed", items: [], error: null } });
  feed("item/completed", { threadId: MAIN, turnId: MAIN_TURN, item: { type: "agentMessage", id: "msg-root", text: "All done.", phase: "final_answer" } });
  feed("turn/completed", { threadId: MAIN, turn: { id: MAIN_TURN, status: "completed", items: [], error: null } });
  return events;
}

function expectRootSettles(events: NormalizedEvent[], n: CodexNormalizer): void {
  const childKeys = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "child" ? [event.activity.childKey] : []));
  expect(childKeys).not.toContain(MAIN);
  expect(new Set(childKeys)).toEqual(new Set([CHILD]));
  expect(events.filter((event) => event.type === "assistant.delta").map((event) => (event.type === "assistant.delta" ? event.delta : ""))).toEqual(["All done."]);
  expect(events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
  expect(n.parentFor(MAIN)).toBeUndefined();
  expect(n.turnId).toBeUndefined();
}

const reportsBack: [string, unknown] = ["item/completed", subAgent(CHILD, CHILD_TURN, "interacted", MAIN, "/root")];

describe("codex sub-agents: the session's own thread is never a child", () => {
  it("a sub-agent item in a child's thread naming the root thread does not turn the root into a child row", () => {
    const n = new CodexNormalizer();
    expectRootSettles(run(n, true, reportsBack), n);
  });

  it("holds on a resumed session (thread id given to the constructor, no thread/started)", () => {
    const n = new CodexNormalizer({ threadId: MAIN });
    expectRootSettles(run(n, false, reportsBack), n);
  });

  it("a non-spawn collab call from the child that names the root keeps its tool row but makes no child row for the root", () => {
    const n = new CodexNormalizer({ threadId: MAIN });
    const events = run(n, false, ["item/completed", collab(CHILD, "sendInput", [MAIN])]);
    expectRootSettles(events, n);
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "tool" && event.activity.toolUseId === "call-sendInput" && event.activity.parentToolUseId === CHILD)).toBe(true);
  });

  it("even a spawn naming the root as a receiver makes no child row for it", () => {
    const n = new CodexNormalizer();
    expectRootSettles(run(n, true, ["item/completed", collab(CHILD, "spawnAgent", [MAIN])]), n);
  });

  it("a thread/started that names the root as its own id under a known child is not announced as a child", () => {
    const n = new CodexNormalizer({ threadId: MAIN });
    expectRootSettles(run(n, false, ["thread/started", { thread: { id: MAIN, parentThreadId: CHILD, agentNickname: "root" } }]), n);
  });
});
