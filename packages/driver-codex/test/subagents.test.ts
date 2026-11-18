import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriverActivity, NormalizedEvent } from "@tide/contracts";
import { ApprovalBroker } from "../src/approvals.ts";
import { CodexNormalizer } from "../src/normalize.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface Line {
  method: string;
  params: Record<string, unknown>;
  /** present on server->client requests */
  id?: string | number;
}

function load(name: string): Line[] {
  return readFileSync(join(fixtures, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
}

/** Replays notifications through the normalizer, and requests through the broker the way the session does. */
function replay(name: string, normalizer = new CodexNormalizer()): { events: NormalizedEvent[]; normalizer: CodexNormalizer; turnIds: (string | undefined)[] } {
  const events: NormalizedEvent[] = [];
  const turnIds: (string | undefined)[] = [];
  const broker = new ApprovalBroker((event) => events.push(event), () => undefined, () => undefined);
  for (const line of load(name)) {
    if (line.id !== undefined) {
      const threadId = typeof line.params["threadId"] === "string" ? line.params["threadId"] : undefined;
      broker.handle({ method: line.method, params: line.params, id: line.id, diffFor: () => undefined, parentToolUseId: normalizer.parentFor(threadId) });
      continue;
    }
    events.push(...normalizer.next(line.method, line.params));
    turnIds.push(normalizer.turnId);
  }
  return { events, normalizer, turnIds };
}

function activities<K extends DriverActivity["kind"]>(events: NormalizedEvent[], kind: K): Extract<DriverActivity, { kind: K }>[] {
  return events.flatMap((event) => (event.type === "activity" && event.activity.kind === kind ? [event.activity as Extract<DriverActivity, { kind: K }>] : []));
}

// Ids from the recordings (codex-cli 0.170.0, test/live.test.ts).
const MAIN = "01a1f087-8852-7493-9355-dee90c5e1fcf";
const MAIN_TURN = "01a1f087-8877-7503-95e2-ab514419422c";
const CHILD = "01a1f087-9c68-7122-bd49-90e1a77d7304";
const LATE_CHILD = "01a1f08b-61d7-7b92-b312-6b45f1c51784";

describe("codex sub-agents, recorded (subagent-turn.ndjson: the parent spawns one child and waits)", () => {
  it("nests every row of the child thread under the child row: parentToolUseId === childKey", () => {
    const { events } = replay("subagent-turn");
    const rows = activities(events, "child");
    expect(new Set(rows.map((row) => row.childKey))).toEqual(new Set([CHILD]));
    expect(rows.every((row) => row.childThreadId === CHILD && row.name === "/root/read_hello" && row.parentToolUseId === undefined)).toBe(true);

    const fromChild = events.flatMap((event) => (event.type === "activity" && event.activity.kind !== "child" && event.activity.parentToolUseId !== undefined ? [event.activity] : []));
    expect(fromChild.length).toBeGreaterThan(0);
    expect(fromChild.every((activity) => activity.parentToolUseId === CHILD)).toBe(true);
    const command = activities(events, "tool").filter((tool) => tool.toolName === "Bash");
    expect(command.map((tool) => [tool.status, tool.parentToolUseId])).toEqual([
      ["running", CHILD],
      ["ok", CHILD],
    ]);
  });

  it("does not let the child's turn lifecycle settle the session's turn or replace its turn id", () => {
    const { events, turnIds } = replay("subagent-turn");
    expect(events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    // from the parent's turn/started to its own turn/completed the id never changes, though the child's turn starts and ends in between
    const running = turnIds.filter((id) => id !== undefined);
    expect(new Set(running)).toEqual(new Set([MAIN_TURN]));
    expect(turnIds.at(-1)).toBeUndefined();
  });

  it("takes the child's status from the child, keeps its prose off the thread and files its last message as the report", () => {
    const { events } = replay("subagent-turn");
    const rows = activities(events, "child");
    expect(rows[0]?.status).toBe("running");
    expect(rows.at(-1)).toMatchObject({ status: "done", report: "hello from tide" });
    // the wait tool call is a tool row of the parent, not a second child row
    expect(activities(events, "tool").filter((tool) => tool.toolName === "wait").map((tool) => [tool.status, tool.parentToolUseId])).toEqual([
      ["running", undefined],
      ["ok", undefined],
    ]);
    const text = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(text).not.toContain("I’ll list the current directory");
    expect(events.some((event) => event.type === "plan.progress" || event.type === "plan.proposed")).toBe(false);
  });
});

describe("codex sub-agents, recorded (subagent-approval-turn.ndjson: the child outlives the parent turn)", () => {
  it("settles once, on the parent's turn/completed; the child's later turn only finishes its row", () => {
    const { events } = replay("subagent-approval-turn");
    const settledAt = events.findIndex((event) => event.type === "settled");
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
    const after = events.slice(settledAt + 1);
    expect(activities(after, "child").at(-1)).toMatchObject({ childKey: LATE_CHILD, status: "done", report: "done" });
  });

  it("stamps the child's approval request with the child's thread id", () => {
    const { events } = replay("subagent-approval-turn");
    const [approval] = activities(events, "approval");
    expect(approval).toMatchObject({ requestId: "0", toolName: "Bash", parentToolUseId: LATE_CHILD });
    expect(approval?.input).toMatchObject({ command: "/bin/zsh -lc 'touch made-by-child.txt'" });
  });
});

describe("codex sub-agents, collab tool calls and child plans (shapes from the 0.170 bindings, not recorded)", () => {
  it("synthetic-subagent-turn: a spawn names its row once and every child row nests under it", () => {
    const { events } = replay("synthetic-subagent-turn");
    const childId = "01a05503-4000-7000-8000-000000000001";
    const rows = activities(events, "child");
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["sub-agent", "running"], // spawnAgent started
      ["scout", "running"], // thread/started carries the nickname
      ["scout", "done"], // agentsStates says completed
    ]);
    expect(rows.every((row) => row.childKey === childId && row.description === "Audit the parser")).toBe(true);
    expect(rows.at(-1)?.summary).toBe("The parser handles 3 cases.");
    expect(activities(events, "tool")[0]?.parentToolUseId).toBe(childId);
    expect(events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : []))).toEqual(["Done."]);
    // the unmodelled notification still renders generically
    const passthrough = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" && event.activity.payload !== undefined ? [event.activity.text] : []));
    expect(passthrough).toEqual(["codex: totally/new"]);
  });

  const collab = (id: string, tool: string, status: string, states: Record<string, { status: string; message: string | null }>, receivers = ["c1"]) => ({
    threadId: "main",
    item: { type: "collabAgentToolCall", id, tool, status, senderThreadId: "main", receiverThreadIds: receivers, prompt: tool === "spawnAgent" ? "Look around" : null, model: null, reasoningEffort: null, agentsStates: states },
  });

  function started(): CodexNormalizer {
    const n = new CodexNormalizer({ threadId: "main" });
    n.next("turn/started", { threadId: "main", turn: { id: "turn-main" } });
    return n;
  }

  it("follows agentsStates, not the collab call's own status, and later calls neither rename nor reopen the row", () => {
    const n = started();
    // spawnAgent completes as soon as the agent exists: the child is still running
    const spawn = activities(n.next("item/completed", collab("call-spawn", "spawnAgent", "completed", { c1: { status: "pendingInit", message: null } })), "child");
    expect(spawn).toEqual([{ kind: "child", childKey: "c1", name: "sub-agent", status: "running", childThreadId: "c1", description: "Look around" }]);

    const waited = n.next("item/completed", collab("call-wait", "wait", "completed", { c1: { status: "completed", message: "all good" } }));
    expect(activities(waited, "tool")).toMatchObject([{ toolUseId: "call-wait", toolName: "wait", status: "ok" }]);
    expect(activities(waited, "child")).toMatchObject([{ childKey: "c1", name: "sub-agent", status: "done", summary: "all good" }]);

    // a stale "running" report on a later call does not reopen the finished child
    const stale = n.next("item/started", collab("call-close", "closeAgent", "inProgress", { c1: { status: "running", message: null } }));
    expect(activities(stale, "child")).toEqual([]);
    const closed = n.next("item/completed", collab("call-close", "closeAgent", "completed", { c1: { status: "shutdown", message: null } }));
    expect(activities(closed, "child")).toEqual([]); // still done, nothing changed
    expect(n.turnId).toBe("turn-main");

    // the child's own turn/started is what reopens it (sendInput woke it)
    expect(activities(n.next("turn/started", { threadId: "c1", turn: { id: "turn-c1" } }), "child")).toMatchObject([{ childKey: "c1", status: "running", name: "sub-agent" }]);
    expect(n.turnId).toBe("turn-main");
    expect(activities(n.next("item/completed", collab("call-x", "spawnAgent", "failed", {}, ["c2"])), "child")).toMatchObject([{ childKey: "c2", status: "error" }]);
    expect(activities(n.next("item/completed", collab("call-y", "sendInput", "completed", {}, ["unknown"])), "child")).toEqual([]);
  });

  it("settles a child row from its own turn/completed and never the session's turn", () => {
    const n = started();
    n.next("item/started", { threadId: "main", item: { type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "c1", agentPath: "/root/a", model: null, reasoningEffort: null } });
    n.next("item/started", { threadId: "main", item: { type: "subAgentActivity", id: "s2", kind: "started", agentThreadId: "c2", agentPath: "/root/b", model: null, reasoningEffort: null } });
    const failed = n.next("turn/completed", { threadId: "c1", turn: { id: "t-c1", status: "failed", error: { message: "boom" } } });
    const interrupted = n.next("turn/completed", { threadId: "c2", turn: { id: "t-c2", status: "interrupted", error: null } });
    expect([...failed, ...interrupted]).toEqual([
      { type: "activity", activity: { kind: "child", childKey: "c1", name: "/root/a", status: "error", childThreadId: "c1", summary: "boom" } },
      { type: "activity", activity: { kind: "child", childKey: "c2", name: "/root/b", status: "error", childThreadId: "c2", summary: "interrupted" } },
    ]);
    expect(n.turnId).toBe("turn-main");
    expect(n.next("turn/completed", { threadId: "main", turn: { id: "turn-main", status: "completed" } })).toEqual([{ type: "settled", status: "completed" }]);
  });

  it("keeps a child's todo list and plan off the thread's own plan progress and ProposedPlan", () => {
    const n = started();
    n.next("item/started", { threadId: "main", item: { type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "c1", agentPath: "/root/a", model: null, reasoningEffort: null } });
    const progress = n.next("turn/plan/updated", { threadId: "c1", turnId: "t-c1", explanation: null, plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "inProgress" }] });
    expect(progress).toEqual([{ type: "activity", activity: { kind: "child", childKey: "c1", name: "/root/a", status: "running", childThreadId: "c1", summary: "Plan 1/2: Write" } }]);
    expect(n.next("item/plan/delta", { threadId: "c1", itemId: "p1", delta: "## Child plan\n" })).toEqual([]);
    expect(n.next("item/completed", { threadId: "c1", item: { type: "plan", id: "p1", text: "## Child plan\n" } })).toEqual([
      { type: "activity", activity: { kind: "info", text: "## Child plan\n", parentToolUseId: "c1" } },
    ]);
    // the thread's own plan still works
    expect(n.next("turn/plan/updated", { threadId: "main", plan: [{ step: "Ship", status: "pending" }] })).toEqual([{ type: "plan.progress", steps: [{ text: "Ship", status: "pending" }] }]);
  });

  it("nests a grandchild under the child that spawned it", () => {
    const n = started();
    n.next("item/started", { threadId: "main", item: { type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "c1", agentPath: "/root/a", model: null, reasoningEffort: null } });
    const grand = n.next("item/started", { threadId: "c1", item: { type: "subAgentActivity", id: "s2", kind: "started", agentThreadId: "g1", agentPath: "/root/a/b", model: null, reasoningEffort: null } });
    expect(activities(grand, "child")).toMatchObject([{ childKey: "g1", parentToolUseId: "c1" }]);
    expect(n.parentFor("g1")).toBe("g1");
    expect(n.parentFor("main")).toBeUndefined();
  });
});
