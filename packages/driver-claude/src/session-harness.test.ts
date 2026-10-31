import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import type { PermissionResultShape } from "./approvals.ts";
import { AsyncQueue } from "./async-queue.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import { ClaudeSession } from "./session.ts";
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

function harness() {
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
  return {
    session,
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

  it("a background sub-agent's own tool calls while idle open nothing; its report opens the turn with its name", async () => {
    const h = harness();
    const [first, report] = runs();
    await userTurn(h, "spin up some subagents", first!);
    // the sub-agent works: its tool_use/tool_result stream with parent_tool_use_id set
    const child = first!.find((m) => m.type === "assistant" && JSON.stringify(m).includes('"name":"Agent"')) as { message: { content: { id?: string }[] } } | undefined;
    const parent = child?.message.content.find((b) => b.id !== undefined)?.id ?? "toolu_parent";
    h.query().push(
      { type: "assistant", parent_tool_use_id: parent, message: { id: "sub-1", role: "assistant", content: [{ type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "ls" } }] } } as ClaudeMessage,
      { type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "a.txt" }] } } as ClaudeMessage,
    );
    await tick();
    await tick();
    expect(h.openedCount()).toBe(0);
    h.query().push(...report!);
    const turn = await h.nextHarnessTurn();
    expect(turn.reason).toBe('sub-agent "Audit feature gaps" reported');
    const events = await collect(turn.events);
    // the held-back sub-agent tool row is replayed at the head of the turn it woke
    expect(events[0]).toMatchObject({ type: "activity", activity: { kind: "tool", toolName: "Bash", parentToolUseId: parent } });
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
