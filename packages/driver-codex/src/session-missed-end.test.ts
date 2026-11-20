import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { fakeSpawn, type FakeAppServer } from "./fake-app-server.ts";
import { CodexSession } from "./session.ts";

const THREAD = "thread-1";
const TURN = "turn-1";
const MISSED = { type: "activity", activity: { kind: "info", text: "Codex reports this turn already ended; Tide did not see its end" } };

async function harness(): Promise<{ session: CodexSession; server: FakeAppServer }> {
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const { spawn, last } = fakeSpawn();
  const session = await CodexSession.open(
    { spawnImpl: spawn, networkAccess: false, tomlReader: () => undefined },
    env,
    { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [] },
    "/usr/bin/codex",
  );
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

/** A running `send` whose `turn/completed` Tide never sees. */
async function running(server: FakeAppServer, session: CodexSession): Promise<{ events: NormalizedEvent[]; done: Promise<void> }> {
  const turn = collect(session.send({ text: "go" }));
  await tick();
  server.notify("turn/started", { threadId: THREAD, turn: { id: TURN, status: "inProgress", items: [] } });
  await tick();
  return turn;
}

async function nextTurnWorks(server: FakeAppServer, session: CodexSession): Promise<void> {
  server.failMethods.clear();
  server.autoReply = "again";
  const next = collect(session.send({ text: "next" }));
  await next.done;
  expect(next.events.at(-1)).toEqual({ type: "settled", status: "completed" });
}

describe("codex session: Codex says the turn is over but Tide missed its end", () => {
  it("a steer refused with 'no active turn' rejects, and settles the running turn as completed", async () => {
    const { session, server } = await harness();
    const turn = await running(server, session);
    server.failMethods.set("turn/steer", "no active turn to steer");
    await expect(session.steer({ text: "also this" })).rejects.toThrow("no active turn to steer");
    await turn.done;
    expect(turn.events.slice(-2)).toEqual([MISSED, { type: "settled", status: "completed" }]);
    await nextTurnWorks(server, session);
    await session.close();
  });

  it("an interrupt refused with 'no active turn' settles the running turn as interrupted", async () => {
    const { session, server } = await harness();
    const turn = await running(server, session);
    server.failMethods.set("turn/interrupt", "no active turn to interrupt");
    await session.interrupt();
    await turn.done;
    expect(turn.events.slice(-2)).toEqual([MISSED, { type: "settled", status: "interrupted" }]);
    await nextTurnWorks(server, session);
    await session.close();
  });

  it("a steer refused for another reason leaves the turn running", async () => {
    const { session, server } = await harness();
    const turn = await running(server, session);
    server.failMethods.set("turn/steer", "expected turn id turn-0 does not match active turn turn-1");
    await expect(session.steer({ text: "also this" })).rejects.toThrow("does not match");
    await tick();
    expect(turn.events.some((event) => event.type === "settled")).toBe(false);
    server.notify("turn/completed", { threadId: THREAD, turn: { id: TURN, status: "completed", items: [], error: null } });
    await turn.done;
    expect(turn.events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    await session.close();
  });

  it("does nothing when the turn already settled before the refusal arrived", async () => {
    const { session, server } = await harness();
    const turn = await running(server, session);
    server.failMethods.set("turn/steer", "no active turn to steer");
    const steer = session.steer({ text: "late" });
    server.notify("turn/completed", { threadId: THREAD, turn: { id: TURN, status: "completed", items: [], error: null } });
    await expect(steer).rejects.toThrow("no active turn");
    await turn.done;
    expect(turn.events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(turn.events).not.toContainEqual(MISSED);
    await nextTurnWorks(server, session);
    await session.close();
  });
});
