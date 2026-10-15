import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { fakeSpawn, type FakeAppServer } from "./fake-app-server.ts";
import { CodexSession } from "./session.ts";

const THREAD = "thread-1";

async function harness(overrides: Partial<OpenSessionOptions> = {}, configure?: (server: FakeAppServer) => void): Promise<{ session: CodexSession; server: FakeAppServer }> {
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const { spawn, last } = fakeSpawn(configure);
  const options: OpenSessionOptions = { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...overrides };
  const session = await CodexSession.open({ spawnImpl: spawn, networkAccess: false, tomlReader: () => undefined }, env, options, "/usr/bin/codex");
  return { session, server: last() };
}

function collect(stream: AsyncIterable<NormalizedEvent>): { events: NormalizedEvent[]; done: Promise<void> } {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of stream) events.push(event);
  })();
  return { events, done };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function completeTurn(server: FakeAppServer, turnId: string, threadId = THREAD): void {
  server.notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], itemsView: "notLoaded", error: null } });
}

/** One full turn on the fake; returns the codex turn id it ran as. */
async function runTurn(session: CodexSession, server: FakeAppServer, turnId: string, threadId = THREAD): Promise<void> {
  server.turnIds.push(turnId);
  const { done } = collect(session.send({ text: `turn ${turnId}` }));
  await tick();
  server.notify("turn/started", { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress" } });
  completeTurn(server, turnId, threadId);
  await done;
}

const settled = (events: NormalizedEvent[]) => events.filter((event) => event.type === "settled");

describe("codex steer", () => {
  it("forwards a mid-turn message with turn/steer and the turn still settles once", async () => {
    const { session, server } = await harness();
    server.turnIds.push("turn-7");
    const { events, done } = collect(session.send({ text: "build it" }));
    await session.steer({ text: "use tabs" });
    expect(server.calls("turn/steer")).toEqual([{ threadId: THREAD, expectedTurnId: "turn-7", input: [{ type: "text", text: "use tabs", text_elements: [] }] }]);
    completeTurn(server, "turn-7");
    await done;
    expect(settled(events)).toEqual([{ type: "settled", status: "completed" }]);
    expect(server.calls("turn/start")).toHaveLength(1);
  });

  it("rejects a steer when no turn is running", async () => {
    const { session, server } = await harness();
    await expect(session.steer({ text: "hello?" })).rejects.toThrow(/no turn is running/);
    await runTurn(session, server, "turn-1");
    await expect(session.steer({ text: "late" })).rejects.toThrow(/no turn is running/);
    expect(server.calls("turn/steer")).toHaveLength(0);
  });

  it("surfaces a turn/steer refusal from codex", async () => {
    const { session, server } = await harness({}, (server) => server.failMethods.set("turn/steer", "expected turn mismatch"));
    const { done } = collect(session.send({ text: "x" }));
    await expect(session.steer({ text: "y" })).rejects.toThrow(/expected turn mismatch/);
    completeTurn(server, "turn-1");
    await done;
  });
});

describe("codex fork", () => {
  it("opens with thread/fork and reports the new thread id", async () => {
    const { session, server } = await harness({ forkFrom: "thread-source", model: "gpt-5.6" });
    expect(server.calls("thread/fork")).toEqual([
      { threadId: "thread-source", cwd: "/tmp/repo", approvalPolicy: "untrusted", sandbox: "workspace-write", excludeTurns: true, model: "gpt-5.6" },
    ]);
    expect(server.calls("thread/start")).toHaveLength(0);
    expect(server.calls("thread/resume")).toHaveLength(0);
    expect(session.nativeSessionId).toBe("thread-fork-1");
    await session.close();
  });

  it("refuses resume and forkFrom together, without leaking the child", async () => {
    const { spawn, last } = fakeSpawn();
    const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
    const options: OpenSessionOptions = { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [], resume: "a", forkFrom: "b" };
    await expect(CodexSession.open({ spawnImpl: spawn, networkAccess: false, tomlReader: () => undefined }, env, options, "/usr/bin/codex")).rejects.toThrow(/mutually exclusive/);
    expect(last().killed).toBe(1);
  });

  it("surfaces a thread/fork failure", async () => {
    await expect(harness({ forkFrom: "gone" }, (server) => server.failMethods.set("thread/fork", "thread not found"))).rejects.toThrow(/thread not found/);
  });
});

describe("codex rollback", () => {
  it("reverts before the first dropped turn of this session", async () => {
    const { session, server } = await harness();
    await runTurn(session, server, "turn-a");
    await runTurn(session, server, "turn-b");
    await runTurn(session, server, "turn-c");
    await session.rollback(2);
    expect(server.calls("thread/revert")).toEqual([{ threadId: THREAD, beforeTurnId: "turn-b" }]);
    await session.rollback(1);
    expect(server.calls("thread/revert")[1]).toEqual({ threadId: THREAD, beforeTurnId: "turn-a" });
    expect(server.calls("thread/turns/list")).toHaveLength(0);
  });

  it("asks codex for older turns on a forked thread", async () => {
    const { session, server } = await harness({ forkFrom: "thread-source" }, (server) => {
      server.listedTurns = ["t3", "t2", "t1"];
    });
    await session.rollback(2);
    expect(server.calls("thread/turns/list")).toEqual([{ threadId: "thread-fork-1", sortDirection: "desc", limit: 2 }]);
    expect(server.calls("thread/revert")).toEqual([{ threadId: "thread-fork-1", beforeTurnId: "t2" }]);
  });

  it("rejects more turns than the thread holds, during a turn, and surfaces revert errors", async () => {
    const { session, server } = await harness({}, (server) => {
      server.listedTurns = ["t1"];
    });
    await expect(session.rollback(2)).rejects.toThrow(/invalid-params/);
    const { done } = collect(session.send({ text: "x" }));
    await expect(session.rollback(1)).rejects.toThrow(/busy/);
    await tick();
    completeTurn(server, "turn-1");
    await done;
    server.failMethods.set("thread/revert", "cannot revert");
    await expect(session.rollback(1)).rejects.toThrow(/cannot revert/);
  });
});
