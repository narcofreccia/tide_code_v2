import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { AsyncQueue } from "./async-queue.ts";
import type { ClaudeMessage, TranscriptEntry } from "./sdk-shapes.ts";
import { ClaudeSession } from "./session.ts";
import type { QueryFn, SessionMessagesFn } from "./types.ts";

interface SentMessage {
  uuid: string;
  message: { content: unknown };
}

/** A scripted CLI that also exposes what Tide wrote into the streaming-input prompt. */
class InputQuery {
  readonly messages = new AsyncQueue<ClaudeMessage>();
  readonly sent: SentMessage[] = [];
  readonly options: Record<string, unknown>;
  interrupts = 0;
  #arrivals = new AsyncQueue<SentMessage>();
  #arrived: AsyncIterator<SentMessage>;

  constructor(prompt: AsyncIterable<unknown>, options: Record<string, unknown>) {
    this.options = options;
    this.#arrived = this.#arrivals.drain();
    void (async () => {
      for await (const raw of prompt) {
        const message = raw as SentMessage;
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
  /** resolves with the next user message Tide writes to the CLI's stdin */
  async nextInput(): Promise<SentMessage> {
    const step = await this.#arrived.next();
    if (step.done) throw new Error("input closed");
    return step.value;
  }
  init(sessionId: string): void {
    this.messages.push({ type: "system", subtype: "init", session_id: sessionId } as ClaudeMessage);
  }
  text(text: string): void {
    this.messages.push({ type: "assistant", uuid: `a-${text}`, parent_tool_use_id: null, message: { content: [{ type: "text", text }] } } as ClaudeMessage);
  }
  result(extra: Record<string, unknown> = {}): void {
    this.messages.push({ type: "result", subtype: "success", session_id: "s", is_error: false, usage: {}, ...extra } as ClaudeMessage);
  }
}

function harness(overrides: Partial<OpenSessionOptions> = {}, transcript: TranscriptEntry[] = []) {
  const queries: InputQuery[] = [];
  const reads: { sessionId: string; options: unknown }[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const queryFn: QueryFn = ({ prompt, options }) => {
    const query = new InputQuery(prompt as AsyncIterable<unknown>, options ?? {});
    queries.push(query);
    return query as unknown as ReturnType<QueryFn>;
  };
  const sessionMessagesImpl: SessionMessagesFn = async (sessionId, options) => {
    reads.push({ sessionId, options });
    return transcript;
  };
  const options: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...overrides };
  const session = new ClaudeSession({ sessionMessagesImpl }, env, options, queryFn);
  return { session, queries, reads, last: () => queries[queries.length - 1]! };
}

async function collect(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const settled = (events: NormalizedEvent[]) => events.filter((event) => event.type === "settled");

/** Runs one complete turn: answers the prompt with `reply` and a result. Returns the prompt uuid. */
async function turn(h: ReturnType<typeof harness>, text: string, sessionId = "session-1"): Promise<string> {
  const done = collect(h.session.send({ text }));
  const query = h.last();
  const prompt = await query.nextInput();
  query.init(sessionId);
  query.text(`re ${text}`);
  query.result({ user_message_uuids: [prompt.uuid] });
  await done;
  return prompt.uuid;
}

const user = (uuid: string, content: unknown = "prompt"): TranscriptEntry => ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content } });
const assistant = (uuid: string): TranscriptEntry => ({ type: "assistant", uuid, parent_tool_use_id: null, message: { content: [] } });

describe("ClaudeSession steer", () => {
  it("writes the steer into the running query's input and settles the turn once", async () => {
    const h = harness();
    const done = collect(h.session.send({ text: "build it" }));
    const query = h.last();
    const prompt = await query.nextInput();
    query.init("session-1");
    await h.session.steer({ text: "use tabs" });
    const steer = await query.nextInput();
    expect(steer.message.content).toBe("use tabs");
    expect(steer.uuid).not.toBe(prompt.uuid);
    query.text("done");
    query.result({ user_message_uuids: [prompt.uuid, steer.uuid], queued_turn_count: 0 });
    const events = await done;
    expect(settled(events)).toEqual([{ type: "settled", status: "completed" }]);
    expect(h.queries).toHaveLength(1);
  });

  it("delivers a steer sent before the stream is consumed after the prompt", async () => {
    const h = harness();
    const stream = h.session.send({ text: "first" });
    await h.session.steer({ text: "second" });
    const done = collect(stream);
    const query = h.last();
    expect((await query.nextInput()).message.content).toBe("first");
    expect((await query.nextInput()).message.content).toBe("second");
    query.result({ user_message_uuids: [query.sent[0]!.uuid, query.sent[1]!.uuid] });
    expect(settled(await done)).toHaveLength(1);
  });

  it("keeps the Tide turn open when the steer missed the fold and runs as the CLI's next turn", async () => {
    const h = harness();
    const done = collect(h.session.send({ text: "build it" }));
    const query = h.last();
    const prompt = await query.nextInput();
    await h.session.steer({ text: "and test it" });
    const steer = await query.nextInput();
    query.text("built");
    query.result({ user_message_uuids: [prompt.uuid], queued_turn_count: 1 });
    query.text("tested");
    query.result({ user_message_uuids: [steer.uuid], queued_turn_count: 0 });
    const events = await done;
    expect(settled(events)).toEqual([{ type: "settled", status: "completed" }]);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(2);
  });

  it("rejects a steer when no turn is running", async () => {
    const h = harness();
    await expect(h.session.steer({ text: "hello?" })).rejects.toThrow(/no turn is running/);
    await turn(h, "one");
    await expect(h.session.steer({ text: "late" })).rejects.toThrow(/no turn is running/);
  });

  it("tears the query down when an interrupt leaves a steer queued, so it cannot leak into the next turn", async () => {
    const h = harness();
    const done = collect(h.session.send({ text: "build it" }));
    const query = h.last();
    const prompt = await query.nextInput();
    query.init("session-1");
    await h.session.steer({ text: "also this" });
    await query.nextInput();
    await h.session.interrupt();
    query.result({ subtype: "error_during_execution", is_error: true, user_message_uuids: [prompt.uuid], queued_turn_count: 1 });
    expect(settled(await done)).toEqual([{ type: "settled", status: "interrupted" }]);
    await turn(h, "next");
    expect(h.queries).toHaveLength(2);
    expect(h.last().options["resume"]).toBe("session-1");
  });
});

describe("ClaudeSession fork", () => {
  it("resumes the source with forkSession and adopts the new session id", async () => {
    const h = harness({ forkFrom: "source-1" });
    expect(h.session.nativeSessionId).toBeUndefined();
    await turn(h, "go on", "forked-2");
    expect(h.queries[0]!.options["resume"]).toBe("source-1");
    expect(h.queries[0]!.options["forkSession"]).toBe(true);
    expect(h.session.nativeSessionId).toBe("forked-2");
  });

  it("refuses resume and forkFrom together", () => {
    expect(() => harness({ resume: "a", forkFrom: "b" })).toThrow(/mutually exclusive/);
  });
});

describe("ClaudeSession rollback", () => {
  it("re-opens with a truncating resume at the kept turn's last entry", async () => {
    const transcript: TranscriptEntry[] = [];
    const h = harness({}, transcript);
    const first = await turn(h, "one");
    const second = await turn(h, "two");
    transcript.push(user(first), assistant("a1"), user("tr1", [{ type: "tool_result", tool_use_id: "x" }]), assistant("a1b"), user(second), assistant("a2"));
    await h.session.rollback(1);
    expect(h.reads).toEqual([{ sessionId: "session-1", options: { dir: "/repo", includeSystemMessages: true } }]);
    await turn(h, "three");
    expect(h.queries).toHaveLength(2);
    expect(h.last().options["resume"]).toBe("session-1");
    expect(h.last().options["resumeSessionAt"]).toBe("a1b");
    expect(h.last().options).not.toHaveProperty("forkSession");
  });

  it("does not count a steered message as a turn", async () => {
    const transcript: TranscriptEntry[] = [];
    const h = harness({}, transcript);
    const first = await turn(h, "one");
    const done = collect(h.session.send({ text: "two" }));
    const query = h.last();
    const second = (await query.nextInput()).uuid;
    await h.session.steer({ text: "nudge" });
    const steer = (await query.nextInput()).uuid;
    query.result({ user_message_uuids: [second, steer] });
    await done;
    transcript.push(user(first), assistant("a1"), user(second), assistant("a2"), user(steer), assistant("a2b"));
    await h.session.rollback(1);
    await turn(h, "again");
    expect(h.last().options["resumeSessionAt"]).toBe("a1");
  });

  it("does not count a message steered into a harness turn as a turn", async () => {
    const transcript: TranscriptEntry[] = [];
    const h = harness({}, transcript);
    const harnessTurn = new Promise<AsyncIterable<NormalizedEvent>>((resolve) => h.session.onHarnessTurn((turn) => resolve(turn.events)));
    const first = await turn(h, "one");
    const second = await turn(h, "two");
    const query = h.last();
    // Claude Code continues by itself
    query.messages.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "on my own" } } } as ClaudeMessage);
    const events = collect(await harnessTurn);
    await h.session.steer({ text: "nudge" });
    const steer = (await query.nextInput()).uuid;
    query.result({ user_message_uuids: [steer] });
    expect(settled(await events)).toEqual([{ type: "settled", status: "completed" }]);
    transcript.push(user(first), assistant("a1"), user(second), assistant("a2"), assistant("a2-own"), user(steer), assistant("a2b"));
    await h.session.rollback(1);
    await turn(h, "again");
    expect(h.last().options["resumeSessionAt"]).toBe("a1");
  });

  it("starts a brand-new session when every turn is dropped", async () => {
    const transcript: TranscriptEntry[] = [];
    const h = harness({}, transcript);
    const first = await turn(h, "one");
    transcript.push(user(first), assistant("a1"));
    await h.session.rollback(1);
    expect(h.session.nativeSessionId).toBeUndefined();
    await turn(h, "fresh", "session-9");
    expect(h.last().options).not.toHaveProperty("resume");
    expect(h.last().options).not.toHaveProperty("resumeSessionAt");
    expect(h.session.nativeSessionId).toBe("session-9");
  });

  it("rolls a fork back before it runs, from the source's transcript", async () => {
    const h = harness({ forkFrom: "source-1" }, [user("p1"), assistant("a1"), user("p2"), assistant("a2"), user("p3"), assistant("a3")]);
    await h.session.rollback(2);
    expect(h.reads[0]!.sessionId).toBe("source-1");
    await turn(h, "continue", "forked-2");
    expect(h.last().options).toMatchObject({ resume: "source-1", forkSession: true, resumeSessionAt: "a1" });
  });

  it("stacks two rollbacks before the next turn", async () => {
    const h = harness({ resume: "session-1" }, [user("p1"), assistant("a1"), user("p2"), assistant("a2"), user("p3"), assistant("a3")]);
    await h.session.rollback(1);
    await h.session.rollback(1);
    await turn(h, "go");
    expect(h.last().options["resumeSessionAt"]).toBe("a1");
  });

  it("rejects rolling back more turns than exist, or during a turn", async () => {
    const h = harness({ resume: "session-1" }, [user("p1"), assistant("a1")]);
    await expect(h.session.rollback(2)).rejects.toThrow(/invalid-params/);
    const done = collect(h.session.send({ text: "x" }));
    await expect(h.session.rollback(1)).rejects.toThrow(/busy/);
    const query = h.last();
    await query.nextInput();
    query.result();
    await done;
    await expect(harness().session.rollback(1)).rejects.toThrow(/no history/);
  });
});
