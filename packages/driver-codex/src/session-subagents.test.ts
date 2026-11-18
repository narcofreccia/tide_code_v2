import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { fakeSpawn, type FakeAppServer } from "./fake-app-server.ts";
import { CodexSession } from "./session.ts";

const THREAD = "thread-1";
const TURN = "turn-1";
const CHILD = "child-1";

async function harness(): Promise<{ session: CodexSession; server: FakeAppServer; logs: string[] }> {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (message) => logs.push(message) };
  const { spawn, last } = fakeSpawn();
  const session = await CodexSession.open(
    { spawnImpl: spawn, networkAccess: false, tomlReader: () => undefined },
    env,
    { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [] },
    "/usr/bin/codex",
  );
  return { session, server: last(), logs };
}

function collect(stream: AsyncIterable<NormalizedEvent>): { events: NormalizedEvent[]; done: Promise<void> } {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of stream) events.push(event);
  })();
  return { events, done };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The order codex 0.170 uses (test/fixtures/subagent-approval-turn.ndjson): spawn item on the parent, then the child's own turn. */
function spawnChild(server: FakeAppServer): void {
  server.notify("item/started", { threadId: THREAD, turnId: TURN, item: { type: "subAgentActivity", id: "call-1", kind: "started", agentThreadId: CHILD, agentPath: "/root/make_file", model: null, reasoningEffort: null } });
  server.notify("turn/started", { threadId: CHILD, turn: { id: "child-turn", status: "inProgress", items: [] } });
}

describe("codex session with sub-agents", () => {
  it("keeps the turn open through the child's turn/completed and interrupts the parent's turn, not the child's", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "spawn one" }));
    await tick();
    server.notify("turn/started", { threadId: THREAD, turn: { id: TURN, status: "inProgress", items: [] } });
    spawnChild(server);
    server.notify("turn/completed", { threadId: CHILD, turn: { id: "child-turn", status: "completed", items: [], error: null } });
    await tick();
    expect(events.some((event) => event.type === "settled")).toBe(false);

    await session.interrupt();
    expect(server.calls("turn/interrupt")[0]).toEqual({ threadId: THREAD, turnId: TURN });
    server.notify("turn/completed", { threadId: THREAD, turn: { id: TURN, status: "interrupted", items: [], error: null } });
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
    await session.close();
  });

  it("holds a child's approval that arrives between turns, answers nothing, and shows it when the next turn starts", async () => {
    const { session, server, logs } = await harness();
    const first = collect(session.send({ text: "spawn one, do not wait" }));
    await tick();
    spawnChild(server);
    server.notify("turn/completed", { threadId: THREAD, turn: { id: TURN, status: "completed", items: [], error: null } });
    await first.done;

    // no turn is running now: the child keeps going and asks for approval
    server.notify("item/started", { threadId: CHILD, turnId: "child-turn", item: { type: "commandExecution", id: "exec-1", command: "touch x", cwd: "/tmp/repo", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } });
    server.serverRequest(0, "item/commandExecution/requestApproval", { threadId: CHILD, turnId: "child-turn", itemId: "exec-1", startedAtMs: 1, command: "touch x", cwd: "/tmp/repo" });
    server.notify("account/rateLimits/updated", { rateLimits: null }); // between-turn chatter stays dropped
    await tick();
    expect(server.replyTo(0)).toBeUndefined();
    expect(logs.some((line) => line.includes("arrived between turns") && line.includes(CHILD))).toBe(true);

    const second = collect(session.send({ text: "next" }));
    await tick();
    const held = second.events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));
    expect(held.map((activity) => [activity.kind, activity.parentToolUseId])).toEqual([
      ["tool", CHILD],
      ["approval", CHILD],
    ]);
    expect(held[1]).toMatchObject({ kind: "approval", requestId: "0", toolName: "Bash", status: "pending" });

    await session.respondApproval("0", "accept");
    await tick();
    expect(server.replyTo(0)?.result).toEqual({ decision: "accept" });

    // the child finishing during this turn settles its row, not the turn
    server.notify("turn/completed", { threadId: CHILD, turn: { id: "child-turn", status: "completed", items: [], error: null } });
    await tick();
    expect(second.events.some((event) => event.type === "settled")).toBe(false);
    expect(second.events.at(-1)).toMatchObject({ type: "activity", activity: { kind: "child", childKey: CHILD, status: "done" } });
    server.notify("turn/completed", { threadId: THREAD, turn: { id: TURN, status: "completed", items: [], error: null } });
    await second.done;
    await session.close();
  });
});
