import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { OpencodeNormalizer, SILENT_EVENTS } from "./normalize.ts";
import type { OpencodeEvent } from "./wire.ts";

const SESSION = "ses_1";

function make(): OpencodeNormalizer {
  return new OpencodeNormalizer({ sessionId: SESSION, agent: "build" });
}

function part(type: string, id: string, messageID: string, text: string, delta?: string): OpencodeEvent {
  return { type: "message.part.updated", properties: { part: { id, sessionID: SESSION, messageID, type, text } as never, ...(delta !== undefined ? { delta } : {}) } };
}

const infos = (events: NormalizedEvent[]): Extract<NormalizedEvent, { type: "activity" }>["activity"][] =>
  events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" ? [event.activity] : []));

describe("reasoning", () => {
  it("streams reasoning on the same messageKey as the text that follows it", () => {
    const normalizer = make();
    const reasoning = normalizer.next(part("reasoning", "prt_reason", "msg_1", "let me think", "let me think"));
    const text = normalizer.next(part("text", "prt_text", "msg_1", "hello", "hello"));

    expect(reasoning).toEqual([{ type: "assistant.reasoning", messageKey: "prt_reason", delta: "let me think" }]);
    // same key -> the reasoning and the answer merge into one assistant message
    expect(text).toEqual([{ type: "assistant.delta", messageKey: "prt_reason", delta: "hello" }]);
  });

  it("derives reasoning deltas from the full text when the server omits `delta`, like text parts", () => {
    const normalizer = make();
    expect(normalizer.next(part("reasoning", "prt_r", "msg_1", "abc"))).toEqual([{ type: "assistant.reasoning", messageKey: "prt_r", delta: "abc" }]);
    expect(normalizer.next(part("reasoning", "prt_r", "msg_1", "abcdef"))).toEqual([{ type: "assistant.reasoning", messageKey: "prt_r", delta: "def" }]);
    // no growth -> no event
    expect(normalizer.next(part("reasoning", "prt_r", "msg_1", "abcdef"))).toEqual([]);
  });

  it("keeps reasoning out of the plan markdown", () => {
    const normalizer = make();
    normalizer.next(part("reasoning", "prt_r", "msg_1", "thinking about it"));
    normalizer.next(part("text", "prt_t", "msg_1", "# Plan\n1. go"));
    const done = normalizer.next({
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID: SESSION, role: "assistant", agent: "plan", time: { created: 1, completed: 2 } } } as never,
    });
    expect(done).toEqual([{ type: "plan.proposed", markdown: "# Plan\n1. go" }]);
  });

  it("keys a message by its first streamed part even when text comes first", () => {
    const normalizer = make();
    normalizer.next(part("text", "prt_t", "msg_1", "hi", "hi"));
    expect(normalizer.next(part("reasoning", "prt_r", "msg_1", "hmm", "hmm"))).toEqual([{ type: "assistant.reasoning", messageKey: "prt_t", delta: "hmm" }]);
  });
});

describe("generic pass-through of untranslated events", () => {
  it("surfaces an unknown event type as an info row carrying the raw event", () => {
    const normalizer = make();
    const event: OpencodeEvent = { type: "session.telepathy", properties: { sessionID: SESSION, mood: "curious" } };
    const events = normalizer.next(event);
    expect(events).toEqual([{ type: "activity", activity: { kind: "info", text: "opencode: session.telepathy", payload: event } }]);
    expect(normalizer.unknownCount).toBe(1);
  });

  it("surfaces known-but-untranslated events too, without counting them as unknown", () => {
    const normalizer = make();
    // real content changes stay visible even though the driver has no first-class row
    const events = normalizer.next({ type: "message.part.removed", properties: { sessionID: SESSION, partID: "prt_1" } });
    expect(infos(events)[0]).toMatchObject({ kind: "info", text: "opencode: message.part.removed" });
    expect(normalizer.unknownCount).toBe(0);
  });

  it("drops only the named housekeeping and already-rendered events", () => {
    const normalizer = make();
    expect([...SILENT_EVENTS]).toEqual([
      "server.heartbeat",
      "file.watcher.updated",
      "session.updated",
      "permission.replied",
      "question.replied",
      "question.rejected",
      "file.edited",
      "session.diff",
      "server.connected",
    ]);
    for (const type of SILENT_EVENTS) expect(normalizer.next({ type, properties: { sessionID: SESSION } })).toEqual([]);
    expect(normalizer.unknownCount).toBe(0);
  });

  it("passes through events with no properties at all", () => {
    const normalizer = make();
    expect(infos(normalizer.next({ type: "brand.new.thing" }))[0]).toMatchObject({ text: "opencode: brand.new.thing" });
  });

  it("ignores another session's events", () => {
    const normalizer = make();
    expect(normalizer.next({ type: "message.removed", properties: { sessionID: "ses_other" } })).toEqual([]);
  });

  it("replaces an oversized payload with its truncated JSON", () => {
    const normalizer = make();
    const event: OpencodeEvent = { type: "session.enormous", properties: { sessionID: SESSION, blob: "x".repeat(6000) } };
    const activity = infos(normalizer.next(event))[0];
    if (activity?.kind !== "info") throw new Error("expected an info activity");
    expect(typeof activity.payload).toBe("string");
    expect(activity.payload as string).toMatch(/… \[truncated \d+ chars]$/);
    expect((activity.payload as string).length).toBeLessThan(4200);
  });
});
