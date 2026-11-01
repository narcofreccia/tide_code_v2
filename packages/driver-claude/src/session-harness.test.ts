import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import type { PermissionResultShape } from "./approvals.ts";
import { AsyncQueue, deferred } from "./async-queue.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import { ClaudeSession, LOST_BACKGROUND_SUMMARY } from "./session.ts";
import type { QueryFn } from "./types.ts";

type CanUseTool = (toolName: string, input: Record<string, unknown>, context: { toolUseID: string }) => Promise<PermissionResultShape>;
type HarnessTurn = { reason: string; events: AsyncIterable<NormalizedEvent> };

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "background-subagent.ndjson");

/** The recorded SDK stream split into runs, each ending with its `result`. */
function runs(): ClaudeMessage[][] {
  const messages = readFileSync(fixture, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaudeMessage);
  const out: ClaudeMessage[][] = [[]];
  for (const message of messages) {
    out[out.length - 1]!.push(message);
    if (message.type === "result") out.push([]);
  }
  return out.filter((run) => run.length > 0);
}

/** A scripted CLI: what Tide writes to its stdin, and a queue of SDK messages it answers with. */
class ScriptedQuery {
  readonly messages = new AsyncQueue<ClaudeMessage>();
  readonly sent: { message: { content: unknown } }[] = [];
  readonly options: Record<string, unknown>;
  interrupts = 0;
  #arrivals = new AsyncQueue<{ message: { content: unknown } }>();
  #arrived = this.#arrivals.drain();

  constructor(prompt: AsyncIterable<unknown>, options: Record<string, unknown>) {
    this.options = options;
    void (async () => {
      for await (const raw of prompt) {
        const message = raw as { message: { content: unknown } };
        this.sent.push(message);
        this.#arrivals.push(message);
      }
    })();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeMessage, void> {
    yield* this.messages.drain();
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
  }
  async nextInput(): Promise<{ message: { content: unknown } }> {
    const step = await this.#arrived.next();
    if (step.done) throw new Error("input closed");
    return step.value;
  }
  canUseTool(toolName: string, input: Record<string, unknown>, toolUseID: string): Promise<PermissionResultShape> {
    return (this.options["canUseTool"] as CanUseTool)(toolName, input, { toolUseID });
  }
  push(...messages: ClaudeMessage[]): void {
    for (const message of messages) this.messages.push(message);
  }
  text(text: string, id = `m-${text}`): void {
    this.push(
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } } as ClaudeMessage,
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } } as ClaudeMessage,
    );
  }
  result(): void {
    this.push({ type: "result", subtype: "success", session_id: "s", is_error: false, usage: {} } as ClaudeMessage);
  }
}

function harness(opts: { idleListener?: boolean } = {}) {
  const queries: ScriptedQuery[] = [];
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (line) => logs.push(line) };
  const queryFn: QueryFn = ({ prompt, options }) => {
    const query = new ScriptedQuery(prompt as AsyncIterable<unknown>, options ?? {});
    queries.push(query);
    return query as unknown as ReturnType<QueryFn>;
  };
  const options: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] };
  const session = new ClaudeSession({}, env, options, queryFn);
  const turns = new AsyncQueue<HarnessTurn>();
  let opened = 0;
  session.onHarnessTurn((turn) => {
    opened += 1;
    turns.push(turn);
  });
  const next = turns.drain();
  const idle: NormalizedEvent[] = [];
  if (opts.idleListener !== false) session.onIdleActivity((event) => idle.push(event));
  return {
    session,
    /** events delivered live through `onIdleActivity` */
    idle,
    logs,
    query: () => queries[queries.length - 1]!,
    queries,
    /** resolves with the next harness turn the session opens */
    nextHarnessTurn: async (): Promise<HarnessTurn> => {
      const step = await next.next();
      if (step.done) throw new Error("no more harness turns");
      return step.value;
    },
    harnessTurnsSoFar: turns,
    /** how many harness turns the session has opened */
    openedCount: () => opened,
  };
}

async function collect<T = NormalizedEvent>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const texts = (events: NormalizedEvent[]) => events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : []));
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs a user turn answered by `messages` (which end in a `result`). */
async function userTurn(h: ReturnType<typeof harness>, text: string, messages: ClaudeMessage[]): Promise<NormalizedEvent[]> {
  const done = collect(h.session.send({ text }));
  const query = h.query();
  await query.nextInput();
  query.push(...messages);
  return done;
}

describe("ClaudeSession harness-initiated turns", () => {
  it("surfaces each autonomous run after a background sub-agent reports as one harness turn", async () => {
    const h = harness();
    const [first, ...autonomous] = runs();
    const userEvents = await userTurn(h, "spin up some subagents", first!);
    expect(userEvents.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(h.session.hasBackgroundWork()).toBe(true);

    const reasons: string[] = [];
    const turns: NormalizedEvent[][] = [];
    for (const run of autonomous) {
      h.query().push(...run);
      const turn = await h.nextHarnessTurn();
      reasons.push(turn.reason);
      turns.push(await collect(turn.events));
    }
    expect(reasons).toEqual(['sub-agent "Audit feature gaps" reported', 'sub-agent "Audit UI/UX and ease of use" reported', 'sub-agent "Audit performance hotspots" reported']);

    const [one, two] = turns;
    expect(one![0]).toMatchObject({ type: "activity", activity: { kind: "child", name: "Audit feature gaps", status: "done" } });
    expect(texts(one!)).toEqual(["The feature audit is in. Its strongest candidates are silence and filler-word removal."]);
    expect(one!.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(one!.filter((event) => event.type === "settled")).toHaveLength(1);
    expect(two!.some((event) => event.type === "activity" && event.activity.kind === "tool" && event.activity.toolName === "Bash" && event.activity.status === "ok")).toBe(true);
    expect(h.session.hasBackgroundWork()).toBe(false);
    expect(h.queries).toHaveLength(1);
  });

  it("hasBackgroundWork stays true until the last backgrounded child has reported", async () => {
    const h = harness();
    const [first, second] = runs();
    await userTurn(h, "go", first!);
    h.query().push(...second!);
    await collect((await h.nextHarnessTurn()).events);
    expect(h.session.hasBackgroundWork()).toBe(true); // two of three still running
  });

  it("a question arriving through canUseTool while idle opens a harness turn", async () => {
    const h = harness();
    const query = () => h.query();
    const done = collect(h.session.send({ text: "hi" }));
    await query().nextInput();
    query().text("hello");
    query().result();
    await done;

    const answer = query().canUseTool("AskUserQuestion", { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] }, "toolu_q");
    const turn = await h.nextHarnessTurn();
    expect(turn.reason).toBe("Claude Code asked a question");
    const events = turn.events[Symbol.asyncIterator]();
    const firstEvent = await events.next();
    expect(firstEvent.value).toMatchObject({ type: "activity", activity: { kind: "user-input", requestId: "toolu_q", status: "pending" } });
    expect(h.session.hasBackgroundWork()).toBe(true);

    await h.session.respondUserInput("toolu_q", { q0: "B" });
    expect(await answer).toMatchObject({ behavior: "allow" });
    query().text("going with B");
    query().result();
    const rest: NormalizedEvent[] = [];
    for (let step = await events.next(); !step.done; step = await events.next()) rest.push(step.value);
    expect(texts(rest)).toEqual(["going with B"]);
    expect(rest.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(h.session.hasBackgroundWork()).toBe(false);
  });

  it("idle bookkeeping opens nothing and a lone result is dropped", async () => {
    const h = harness();
    await userTurn(h, "hi", [{ type: "system", subtype: "init", session_id: "s1" } as ClaudeMessage, { type: "result", subtype: "success", is_error: false, usage: {} } as ClaudeMessage]);
    h.query().push({ type: "system", subtype: "init", session_id: "s2" } as ClaudeMessage, { type: "system", subtype: "status" } as ClaudeMessage);
    h.query().result();
    // a substantive message afterwards still opens exactly one turn
    h.query().text("unprompted");
    h.query().result();
    const turn = await h.nextHarnessTurn();
    expect(turn.reason).toBe("Claude Code continued on its own");
    const events = await collect(turn.events);
    expect(texts(events)).toEqual(["unprompted"]);
    expect(h.session.nativeSessionId).toBe("s2");
  });

  /** A sub-agent working between turns: its task row starts and progresses, it runs a Bash call. */
  function subAgentWork(parent: string): ClaudeMessage[] {
    return [
      { type: "system", subtype: "task_started", task_id: "task-sub", tool_use_id: parent, description: "Audit feature gaps", subagent_type: "Explore" } as ClaudeMessage,
      { type: "assistant", parent_tool_use_id: parent, message: { id: "sub-1", role: "assistant", content: [{ type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "ls" } }] } } as ClaudeMessage,
      { type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "a.txt" }] } } as ClaudeMessage,
      { type: "system", subtype: "task_progress", task_id: "task-sub", summary: "Reading the editor" } as ClaudeMessage,
    ];
  }
  const PARENT = "toolu_01Ji2F6wAAbCG4NMx87dmXi2"; // the fixture's "Audit feature gaps" Agent call

  it("a background sub-agent's tool calls and progress while idle stream live and open nothing; its report opens the turn", async () => {
    const h = harness();
    const [first, report] = runs();
    await userTurn(h, "spin up some subagents", first!);
    h.query().push(...subAgentWork(PARENT));
    await tick();
    await tick();
    expect(h.openedCount()).toBe(0);
    expect(h.idle.map((event) => (event.type === "activity" ? [event.activity.kind, "status" in event.activity ? event.activity.status : undefined] : [event.type]))).toEqual([
      ["child", "running"],
      ["tool", "running"],
      ["tool", "ok"],
      ["child", "running"],
    ]);
    expect(h.idle[1]).toMatchObject({ type: "activity", activity: { kind: "tool", toolName: "Bash", parentToolUseId: PARENT } });
    expect(h.idle[3]).toMatchObject({ type: "activity", activity: { kind: "child", childKey: PARENT, summary: "Reading the editor" } });

    h.query().push(...report!);
    const turn = await h.nextHarnessTurn();
    expect(turn.reason).toBe('sub-agent "Audit feature gaps" reported');
    const events = await collect(turn.events);
    // already delivered live: nothing of the sub-agent's work is replayed at the head of the turn
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "tool" && event.activity.parentToolUseId === PARENT)).toBe(false);
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "child" && event.activity.status === "running")).toBe(false);
    expect(events[0]).toMatchObject({ type: "activity", activity: { kind: "child", status: "done" } });
    expect(h.idle).toHaveLength(4);
  });

  it("without an idle-activity listener the sub-agent's work is held and replayed at the head of the turn it wakes", async () => {
    const h = harness({ idleListener: false });
    const [first, report] = runs();
    await userTurn(h, "spin up some subagents", first!);
    h.query().push(...subAgentWork(PARENT));
    await tick();
    await tick();
    expect(h.openedCount()).toBe(0);
    h.query().push(...report!);
    const turn = await h.nextHarnessTurn();
    expect(turn.reason).toBe('sub-agent "Audit feature gaps" reported');
    const events = await collect(turn.events);
    expect(events[0]).toMatchObject({ type: "activity", activity: { kind: "tool", toolName: "Bash", parentToolUseId: PARENT } });
    expect(h.idle).toHaveLength(0);
  });

  it("send() during a harness turn waits for it to settle, then runs without mixing events", async () => {
    const h = harness();
    const [first, second] = runs();
    await userTurn(h, "go", first!);
    const query = h.query();
    const notification = second!.filter((message) => message.type !== "result");
    query.push(...notification);
    const turn = await h.nextHarnessTurn();
    const harnessEvents = collect(turn.events);

    const sent = h.session.send({ text: "next please" });
    expect(() => h.session.send({ text: "again" })).toThrow(/busy/);
    const userEvents = collect(sent);
    await tick();
    expect(query.sent).toHaveLength(1); // only the first prompt: the send is queued behind the harness turn

    query.result(); // the harness turn ends
    const prompt = await query.nextInput();
    expect(prompt.message.content).toBe("next please");
    query.text("answer to next");
    query.result();

    const own = await harnessEvents;
    const mine = await userEvents;
    expect(texts(own)).toEqual(["The feature audit is in. Its strongest candidates are silence and filler-word removal."]);
    expect(own.filter((event) => event.type === "settled")).toHaveLength(1);
    expect(texts(mine)).toEqual(["answer to next"]);
    expect(mine.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
  });

  it("interrupt() during a harness turn interrupts the query and settles it as interrupted", async () => {
    const h = harness();
    await userTurn(h, "go", runs()[0]!);
    h.query().text("working on my own");
    const turn = await h.nextHarnessTurn();
    const events = collect(turn.events);
    await h.session.interrupt();
    expect(h.query().interrupts).toBe(1);
    h.query().result();
    expect((await events).at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("a stream that ends between turns closes the unreported background sub-agents as lost", async () => {
    const h = harness();
    const [first, second] = runs();
    await userTurn(h, "spin up some subagents", first!);
    h.query().push(...second!);
    await collect((await h.nextHarnessTurn()).events); // one of three reported
    h.idle.length = 0;
    h.query().messages.close(); // the CLI process went away
    await tick();
    await tick();
    const lost = h.idle.flatMap((event) => (event.type === "activity" && event.activity.kind === "child" ? [event.activity] : []));
    expect(lost).toHaveLength(2);
    for (const child of lost) expect(child).toMatchObject({ status: "error", summary: LOST_BACKGROUND_SUMMARY });
    expect(lost.map((child) => child.name)).not.toContain("Audit feature gaps");
    expect(h.session.hasBackgroundWork()).toBe(false);
    expect(h.openedCount()).toBe(1);
  });

  it("close() leaves background sub-agents to the server (no lost rows from the driver)", async () => {
    const h = harness();
    await userTurn(h, "go", runs()[0]!);
    expect(h.session.hasBackgroundWork()).toBe(true);
    h.idle.length = 0;
    await h.session.close();
    await tick();
    expect(h.idle).toEqual([]);
  });

  it("close() while idle resolves and nothing is emitted afterwards", async () => {
    const h = harness();
    await userTurn(h, "go", runs()[0]!);
    await h.session.close();
    h.query().text("too late");
    h.query().result();
    await tick();
    await tick();
    h.harnessTurnsSoFar.close();
    expect(await collect(h.harnessTurnsSoFar.drain())).toEqual([]);
  });

  it("close() during a harness turn settles it once and ends its iterable", async () => {
    const h = harness();
    await userTurn(h, "go", runs()[0]!);
    h.query().text("busy");
    const turn = await h.nextHarnessTurn();
    const events = collect(turn.events);
    await h.session.close();
    const out = await events;
    expect(out.at(-1)).toMatchObject({ type: "settled", status: "interrupted" });
    expect(out.filter((event) => event.type === "settled")).toHaveLength(1);
  });

  it("without a listener the run is read and dropped so the CLI never stalls", async () => {
    const logs: string[] = [];
    const queries: ScriptedQuery[] = [];
    const queryFn: QueryFn = ({ prompt, options }) => {
      const query = new ScriptedQuery(prompt as AsyncIterable<unknown>, options ?? {});
      queries.push(query);
      return query as unknown as ReturnType<QueryFn>;
    };
    const session = new ClaudeSession({}, { dataDir: tmpdir(), log: (line) => logs.push(line) }, { threadId: "t", cwd: "/r", mode: "approval-required", interaction: "default", mcpServers: [] }, queryFn);
    const first = collect(session.send({ text: "a" }));
    await queries[0]!.nextInput();
    queries[0]!.result();
    await first;
    queries[0]!.text("on my own");
    queries[0]!.result();
    // let the idle reader take the unprompted run (a send arriving first would read it itself)
    await tick();
    await tick();
    // the next send still goes through: the unheard run settled
    const second = collect(session.send({ text: "b" }));
    expect((await queries[0]!.nextInput()).message.content).toBe("b");
    queries[0]!.text("reply");
    queries[0]!.result();
    expect(texts(await second)).toEqual(["reply"]);
    expect(logs.filter((line) => line.includes("nobody listens"))).toHaveLength(1);
  });
});

describe("ClaudeSession steer during a harness turn", () => {
  const uuidOf = (message: { message: { content: unknown } }): string => (message as unknown as { uuid: string }).uuid;
  const resultWith = (extra: Record<string, unknown>): ClaudeMessage => ({ type: "result", subtype: "success", session_id: "s", is_error: false, usage: {}, ...extra }) as ClaudeMessage;

  /** A finished user turn, then a harness turn Claude Code opened on its own (left running). */
  async function inHarnessTurn() {
    const h = harness();
    await userTurn(h, "go", runs()[0]!);
    h.query().text("working on my own");
    const turn = await h.nextHarnessTurn();
    return { h, query: h.query(), events: collect(turn.events) };
  }

  it("pushes the steer into the live input and the harness turn's result acknowledges it", async () => {
    const { h, query, events } = await inHarnessTurn();
    const before = query.sent.length;
    await h.session.steer({ text: "also check the tests" });
    const steer = await query.nextInput();
    expect(steer.message.content).toBe("also check the tests");
    expect(query.sent).toHaveLength(before + 1);
    query.text("checking the tests too");
    query.push(resultWith({ user_message_uuids: [uuidOf(steer)], queued_turn_count: 0 }));
    const out = await events;
    expect(texts(out)).toEqual(["working on my own", "checking the tests too"]);
    expect(out.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(h.session.hasBackgroundWork()).toBe(true); // the fixture's sub-agents are still out
    expect(h.openedCount()).toBe(1);

    // the next send is a clean turn of its own
    const next = collect(h.session.send({ text: "next" }));
    expect((await query.nextInput()).message.content).toBe("next");
    query.text("reply");
    query.result();
    expect(texts(await next)).toEqual(["reply"]);
  });

  it("keeps the harness turn open when the steer missed the fold and runs as the CLI's next turn", async () => {
    const { h, query, events } = await inHarnessTurn();
    await h.session.steer({ text: "and then summarize" });
    const steer = await query.nextInput();
    query.push(resultWith({ user_message_uuids: [], queued_turn_count: 1 }));
    query.text("summary");
    query.push(resultWith({ user_message_uuids: [uuidOf(steer)], queued_turn_count: 0 }));
    const out = await events;
    expect(texts(out)).toEqual(["working on my own", "summary"]);
    expect(out.filter((event) => event.type === "settled")).toHaveLength(1);
    expect(h.openedCount()).toBe(1);
  });

  it("refuses a steer once the harness turn's result is read, and after it ended", async () => {
    const { h, query, events } = await inHarnessTurn();
    const usage = deferred<{ totalTokens: number; maxTokens: number }>();
    const asked = deferred<void>();
    Object.assign(query, {
      getContextUsage: () => {
        asked.resolve();
        return usage.promise;
      },
    });
    query.result();
    await asked.promise; // the result is read; the turn is settling
    const sent = query.sent.length;
    await expect(h.session.steer({ text: "too late" })).rejects.toThrow(/ending/);
    usage.resolve({ totalTokens: 10, maxTokens: 100 });
    expect((await events).at(-1)).toEqual({ type: "settled", status: "completed" });
    await expect(h.session.steer({ text: "later still" })).rejects.toThrow(/no turn is running/);
    expect(query.sent).toHaveLength(sent); // nothing reached the CLI
  });

  it("a steer for a send waiting behind a harness turn goes with that send's prompt", async () => {
    const { h, query, events } = await inHarnessTurn();
    const sent = collect(h.session.send({ text: "next please" }));
    await h.session.steer({ text: "for the send" });
    await tick();
    const before = query.sent.length;
    query.result(); // the harness turn ends without the steer
    expect(texts(await events)).toEqual(["working on my own"]);
    expect((await query.nextInput()).message.content).toBe("next please");
    expect((await query.nextInput()).message.content).toBe("for the send");
    expect(query.sent.length).toBe(before + 2);
    query.push(resultWith({ user_message_uuids: query.sent.slice(-2).map(uuidOf) }));
    expect((await sent).filter((event) => event.type === "settled")).toHaveLength(1);
  });

  it("an interrupt with a steer still queued settles the turn without tearing the query down", async () => {
    const { h, query, events } = await inHarnessTurn();
    await h.session.steer({ text: "and this" });
    await query.nextInput();
    await h.session.interrupt();
    query.push(resultWith({ subtype: "error_during_execution", is_error: true, user_message_uuids: [], queued_turn_count: 1 }));
    expect((await events).at(-1)).toMatchObject({ type: "settled", status: "interrupted" });
    // the CLI runs the queued steer next: it surfaces as a harness turn, nothing is lost
    query.text("doing this");
    const turn = await h.nextHarnessTurn();
    query.result();
    expect(texts(await collect(turn.events))).toEqual(["doing this"]);
    expect(h.queries).toHaveLength(1);
  });
});
