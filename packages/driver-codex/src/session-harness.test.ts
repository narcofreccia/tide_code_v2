import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriverActivity, DriverEnv, HarnessTurnHandle, NormalizedEvent } from "@tide/contracts";
import { fakeSpawn, type FakeAppServer } from "./fake-app-server.ts";
import { CodexSession } from "./session.ts";

// Recorded on codex-cli 0.170.0 (test/live.test.ts): the parent spawns one child and ends its
// turn without waiting; the child then asks to run a command and finishes on its own.
const MAIN = "01a1f08b-510e-7a70-980e-b2bf009b35ec";
const MAIN_TURN = "01a1f08b-5123-7b41-a461-265e1995770b";
const CHILD = "01a1f08b-61d7-7b92-b312-6b45f1c51784";
const CHILD_TURN = "01a1f08b-61e4-7483-a237-40cf80a04293";

interface Line {
  method: string;
  params: Record<string, unknown>;
  id?: string | number;
}

const fixture: Line[] = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/subagent-approval-turn.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Line);
const threadOf = (line: Line): unknown => line.params["threadId"];
/** index of the parent's own turn/completed: everything after it arrives between turns */
const PARENT_DONE = fixture.findIndex((line) => line.method === "turn/completed" && threadOf(line) === MAIN);
const REQUEST = fixture.findIndex((line) => line.id !== undefined);

function play(server: FakeAppServer, lines: Line[]): void {
  for (const line of lines) {
    if (line.id !== undefined) server.serverRequest(line.id, line.method, line.params);
    else server.notify(line.method, line.params);
  }
}

interface Harness {
  session: CodexSession;
  server: FakeAppServer;
  idle: NormalizedEvent[];
  turns: { handle: HarnessTurnHandle; events: NormalizedEvent[]; done: Promise<void> }[];
}

async function open(listen = true): Promise<Harness> {
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const { spawn, last } = fakeSpawn((server) => {
    server.threadId = MAIN;
    server.turnId = MAIN_TURN;
  });
  const session = await CodexSession.open(
    { spawnImpl: spawn, networkAccess: false, tomlReader: () => undefined },
    env,
    { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [] },
    "/usr/bin/codex",
  );
  const harness: Harness = { session, server: last(), idle: [], turns: [] };
  if (listen) {
    session.onIdleActivity((event) => harness.idle.push(event));
    session.onHarnessTurn((handle) => {
      const events: NormalizedEvent[] = [];
      const done = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      harness.turns.push({ handle, events, done });
    });
  }
  return harness;
}

async function drain(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Runs the recorded parent turn up to and including its turn/completed. */
async function parentTurn(h: Harness): Promise<NormalizedEvent[]> {
  const turn = drain(h.session.send({ text: "spawn one, do not wait" }));
  await tick();
  play(h.server, fixture.slice(0, PARENT_DONE + 1));
  return turn;
}

function activities(events: NormalizedEvent[]): DriverActivity[] {
  return events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));
}

/** The child's own row, or a row it produced. */
const ofChild = (a: DriverActivity): boolean => (a.kind === "child" ? a.childKey === CHILD : a.parentToolUseId === CHILD);

describe("codex session: a sub-agent that outlives its parent's turn (subagent-approval-turn.ndjson)", () => {
  it("streams the child's rows as idle activity, opens a harness turn for its approval, and goes quiet when it finishes", async () => {
    const h = await open();
    const first = await parentTurn(h);
    expect(first.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(activities(first).filter((a) => a.kind === "child").at(-1)).toMatchObject({ childKey: CHILD, status: "running" });
    expect(h.session.hasBackgroundWork()).toBe(true);

    // the child works on: its rows arrive live, one by one, no turn is opened
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST));
    expect(h.turns).toHaveLength(0);
    const idle = activities(h.idle);
    expect(idle.length).toBe(h.idle.length);
    expect(idle.every(ofChild)).toBe(true);
    expect(idle.filter((a) => a.kind === "tool").map((a) => [a.parentToolUseId, a.kind === "tool" ? a.status : undefined])).toEqual([[CHILD, "running"]]);

    // its approval opens a harness turn with the card; nothing is answered for the user
    play(h.server, fixture.slice(REQUEST, REQUEST + 1));
    await tick();
    expect(h.turns.map((turn) => turn.handle.reason)).toEqual(['sub-agent "/root/create_file" needs approval']);
    const [turn] = h.turns;
    expect(activities(turn!.events)).toEqual([
      expect.objectContaining({ kind: "approval", requestId: "0", toolName: "Bash", status: "pending", title: 'Bash (sub-agent "/root/create_file")' }),
    ]);
    // its row lives on a settled turn on the server, so the card cannot nest under it
    expect(activities(turn!.events)[0]?.parentToolUseId).toBeUndefined();
    expect(h.server.replyTo(0)).toBeUndefined();

    // answering routes to the parked JSON-RPC request and settles the harness turn
    await h.session.respondApproval("0", "accept");
    await turn!.done;
    expect(h.server.replyTo(0)?.result).toEqual({ decision: "accept" });
    expect(turn!.events.at(-1)).toEqual({ type: "settled", status: "completed" });

    // the rest is idle again, ending with the child's row done with its report
    const before = h.idle.length;
    play(h.server, fixture.slice(REQUEST + 1));
    const later = activities(h.idle.slice(before));
    expect(later.every(ofChild)).toBe(true);
    expect(later.filter((a) => a.kind === "tool").map((a) => (a.kind === "tool" ? a.status : undefined))).toEqual(["ok"]);
    expect(later.at(-1)).toMatchObject({ kind: "child", childKey: CHILD, status: "done", report: "done" });
    expect(h.turns).toHaveLength(1);
    expect(h.session.hasBackgroundWork()).toBe(false);
    await h.session.close();
  });

  it("makes a send wait behind the open harness turn and keeps the request answerable", async () => {
    const h = await open();
    await parentTurn(h);
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    await tick();
    expect(h.turns).toHaveLength(1);

    const next = drain(h.session.send({ text: "anything new?" }));
    await tick();
    expect(h.server.calls("turn/start")).toHaveLength(1); // only the first turn: this one waits
    await expect(h.session.steer({ text: "hurry" })).rejects.toThrow(/sub-agent's request is waiting/);

    await h.session.respondApproval("0", "accept");
    await h.turns[0]!.done;
    await tick();
    expect(h.server.replyTo(0)?.result).toEqual({ decision: "accept" });
    expect(h.server.calls("turn/start")).toHaveLength(2);
    h.server.notify("turn/started", { threadId: MAIN, turn: { id: "turn-2", status: "inProgress", items: [] } });
    h.server.notify("turn/completed", { threadId: MAIN, turn: { id: "turn-2", status: "completed", items: [], error: null } });
    expect((await next).at(-1)).toEqual({ type: "settled", status: "completed" });
    await h.session.close();
  });

  it("interrupting the harness turn cancels the request and interrupts the child's own turn", async () => {
    const h = await open();
    await parentTurn(h);
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    await tick();

    await h.session.interrupt();
    await h.turns[0]!.done;
    expect(h.server.replyTo(0)?.result).toEqual({ decision: "cancel" });
    expect(h.server.calls("turn/interrupt")).toEqual([{ threadId: CHILD, turnId: CHILD_TURN }]);
    expect(h.turns[0]!.events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
    await h.session.close();
  });

  it("closes the card and settles when Codex withdraws the request itself", async () => {
    const h = await open();
    await parentTurn(h);
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    await tick();

    h.server.notify("serverRequest/resolved", { threadId: CHILD, requestId: 0 });
    await h.turns[0]!.done;
    expect(activities(h.turns[0]!.events).at(-1)).toMatchObject({ kind: "approval", requestId: "0", status: "resolved", decision: "cancel" });
    expect(h.turns[0]!.events.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(h.server.replyTo(0)).toBeUndefined();
    // a later answer reaches nothing
    await h.session.respondApproval("0", "accept");
    expect(h.server.replyTo(0)).toBeUndefined();
    await h.session.close();
  });

  it("counts a recorded request turn for rollback without a Codex turn behind it, and forgets a dismissed one", async () => {
    const h = await open();
    await parentTurn(h);
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    await h.session.respondApproval("0", "accept");
    await h.turns[0]!.done;

    await h.session.rollback(1); // only the harness turn: nothing to drop in Codex
    expect(h.server.calls("thread/revert")).toEqual([]);
    await h.session.rollback(1); // now the parent's turn
    expect(h.server.calls("thread/revert")).toEqual([{ threadId: MAIN, beforeTurnId: MAIN_TURN }]);
    await h.session.close();

    const d = await open();
    await parentTurn(d);
    play(d.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    d.turns[0]!.handle.dismiss?.(); // the server will not record it
    await d.session.respondApproval("0", "accept");
    await d.turns[0]!.done;
    await d.session.rollback(1);
    expect(d.server.calls("thread/revert")).toEqual([{ threadId: MAIN, beforeTurnId: MAIN_TURN }]);
    await d.session.close();
  });

  it("with no listeners wired, holds the child's rows and request for the next send", async () => {
    const h = await open(false);
    await parentTurn(h);
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    await tick();
    expect(h.server.replyTo(0)).toBeUndefined();

    const next = drain(h.session.send({ text: "next" }));
    await tick();
    await h.session.respondApproval("0", "accept");
    await tick();
    expect(h.server.replyTo(0)?.result).toEqual({ decision: "accept" });
    h.server.notify("turn/completed", { threadId: MAIN, turn: { id: MAIN_TURN, status: "completed", items: [], error: null } });
    const held = activities(await next);
    expect(held.filter((a) => a.kind !== "approval").every(ofChild)).toBe(true);
    expect(held.filter((a) => a.kind === "tool" || a.kind === "approval").map((a) => [a.kind, a.parentToolUseId ?? null])).toEqual([
      ["tool", CHILD],
      ["approval", null],
    ]);
    await h.session.close();
  });
});

describe("codex session: turns Codex starts on its own", () => {
  it("opens a harness turn for the parent's own turn/started and settles it on its turn/completed", async () => {
    const h = await open();
    await parentTurn(h);
    h.server.notify("turn/started", { threadId: MAIN, turn: { id: "turn-self", status: "inProgress", items: [] } });
    h.server.notify("item/agentMessage/delta", { threadId: MAIN, turnId: "turn-self", itemId: "m1", delta: "the child is done" });
    await tick();
    expect(h.turns.map((turn) => turn.handle.reason)).toEqual(["Codex continued on its own"]);

    await h.session.steer({ text: "and then?" }, { turnKey: h.turns[0]!.handle.key! });
    expect(h.server.calls("turn/steer").at(-1)).toMatchObject({ threadId: MAIN, expectedTurnId: "turn-self" });

    h.server.notify("turn/completed", { threadId: MAIN, turn: { id: "turn-self", status: "completed", items: [], error: null } });
    await h.turns[0]!.done;
    expect(h.turns[0]!.events.map((event) => event.type)).toEqual(["assistant.delta", "settled"]);

    // it is a Codex turn of its own: rolling it back reverts it
    await h.session.rollback(1);
    expect(h.server.calls("thread/revert")).toEqual([{ threadId: MAIN, beforeTurnId: "turn-self" }]);
    await h.session.close();
  });

  it("keeps a harness turn open past the parent's turn/completed while a sub-agent's request waits", async () => {
    const h = await open();
    await parentTurn(h);
    play(h.server, fixture.slice(PARENT_DONE + 1, REQUEST + 1));
    await tick();
    h.server.notify("turn/started", { threadId: MAIN, turn: { id: "turn-self", status: "inProgress", items: [] } });
    h.server.notify("turn/completed", { threadId: MAIN, turn: { id: "turn-self", status: "completed", items: [], error: null } });
    await tick();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.events.some((event) => event.type === "settled")).toBe(false);

    await h.session.respondApproval("0", "accept");
    await h.turns[0]!.done;
    expect(h.turns[0]!.events.at(-1)).toEqual({ type: "settled", status: "completed" });
    await h.session.close();
  });
});

describe("codex session: requests from a sub-agent inside a send", () => {
  it("nests the card under a child spawned in this turn", async () => {
    const h = await open();
    const turn = drain(h.session.send({ text: "spawn and wait" }));
    await tick();
    play(h.server, fixture.slice(0, PARENT_DONE).filter((line) => !(line.method === "turn/completed" && threadOf(line) === MAIN)));
    h.server.serverRequest(7, "item/commandExecution/requestApproval", { threadId: CHILD, turnId: CHILD_TURN, itemId: "x", command: "ls", cwd: "/tmp/repo" });
    await tick();
    await h.session.respondApproval("7", "accept");
    h.server.notify("turn/completed", { threadId: MAIN, turn: { id: MAIN_TURN, status: "completed", items: [], error: null } });
    const approval = activities(await turn).find((a) => a.kind === "approval");
    expect(approval).toMatchObject({ requestId: "7", parentToolUseId: CHILD });
    expect(approval && "title" in approval ? approval.title : undefined).toBeUndefined();
    await h.session.close();
  });
});
