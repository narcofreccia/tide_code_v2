import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { PI_SILENT_EVENTS, PiNormalizer } from "../src/index.ts";
import type { PiEvent } from "../src/types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi");

function run(name: string): { events: NormalizedEvent[]; unknown: number } {
  const normalizer = new PiNormalizer();
  const events: NormalizedEvent[] = [];
  for (const line of readFileSync(join(fixtures, `${name}.ndjson`), "utf8").split("\n").filter((line) => line.trim() !== "")) {
    events.push(...normalizer.next(JSON.parse(line) as PiEvent));
  }
  return { events, unknown: normalizer.unknownCount };
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

describe("normalizer over recorded pi events", () => {
  it("basic-turn: exact event sequence", () => {
    const { events, unknown } = run("basic-turn");
    expect(kinds(events)).toEqual([
      "activity:info", // turn_start, passed through generically
      "assistant.delta",
      "assistant.delta",
      "assistant.reasoning",
      "activity:tool", // bash running (tool_execution_update is a silent duplicate)
      "activity:tool", // bash ok
      "activity:info", // turn_end, passed through generically
      "assistant.delta",
      "activity:info", // compaction start
      "activity:info", // compaction end
      "activity:info", // totally_new_event, passed through generically
      "settled",
    ]);
    // turn_start, turn_end and totally_new_event are all unmodelled
    expect(unknown).toBe(3);
  });

  it("keeps thinking out of the assistant text and separates the two messages", () => {
    const { events } = run("basic-turn");
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event] : []));
    expect(deltas.map((delta) => delta.delta).join("")).toBe("Listing the files.Two files.");
    expect(deltas.map((delta) => delta.delta).join("")).not.toContain("secret");
    expect(deltas[0]?.messageKey).toBe(deltas[1]?.messageKey);
    expect(deltas[2]?.messageKey).not.toBe(deltas[0]?.messageKey);
  });

  it("emits thinking as reasoning on the same messageKey as the message's text", () => {
    const { events } = run("basic-turn");
    const reasoning = events.flatMap((event) => (event.type === "assistant.reasoning" ? [event] : []));
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event] : []));
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.delta).toBe("secret reasoning");
    // same message as the text around it (contentIndex 1 vs 0 must not split them)…
    expect(reasoning[0]?.messageKey).toBe(deltas[0]?.messageKey);
    // …and not the *next* assistant message
    expect(reasoning[0]?.messageKey).not.toBe(deltas[2]?.messageKey);
  });

  it("interleaves reasoning and text of one message under one key, and keeps messages apart", () => {
    const normalizer = new PiNormalizer();
    const thinking = (delta: string, contentIndex: number): PiEvent => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta } });
    const text = (delta: string, contentIndex: number): PiEvent => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta } });
    normalizer.next({ type: "message_start" });
    const first = [...normalizer.next(thinking("plan", 0)), ...normalizer.next(text("hi", 1)), ...normalizer.next(thinking("more", 2))];
    normalizer.next({ type: "message_start" });
    const second = normalizer.next(text("bye", 0));
    expect(first.map((event) => event.type)).toEqual(["assistant.reasoning", "assistant.delta", "assistant.reasoning"]);
    expect(new Set(first.map((event) => (event.type === "assistant.delta" || event.type === "assistant.reasoning" ? event.messageKey : "")))).toEqual(new Set(["pi-1"]));
    expect(second[0]).toEqual({ type: "assistant.delta", messageKey: "pi-2", delta: "bye" });
  });

  it("passes unknown events through as an info activity carrying the raw frame", () => {
    const normalizer = new PiNormalizer();
    expect(normalizer.next({ type: "brand_new", foo: 1 })).toEqual([{ type: "activity", activity: { kind: "info", text: "pi: brand_new", payload: { type: "brand_new", foo: 1 } } }]);
    expect(normalizer.unknownCount).toBe(1);
  });

  it("truncates an oversized payload to a JSON string", () => {
    const normalizer = new PiNormalizer();
    const [event] = normalizer.next({ type: "huge", blob: "x".repeat(9000) });
    const payload = event?.type === "activity" && event.activity.kind === "info" ? event.activity.payload : undefined;
    expect(typeof payload).toBe("string");
    expect(payload as string).toMatch(/more characters\)$/);
    expect((payload as string).length).toBeLessThan(4200);
  });

  it("drops only the content-free housekeeping frames", () => {
    expect([...PI_SILENT_EVENTS]).toEqual(["agent_start", "agent_end", "queue_update", "tool_execution_update", "bash_execution_update"]);
    const normalizer = new PiNormalizer();
    for (const type of PI_SILENT_EVENTS) expect(normalizer.next({ type })).toEqual([]);
    expect(normalizer.unknownCount).toBe(0);
  });

  it("pairs tool start and end on the same toolCallId and renders the output", () => {
    const tools = run("basic-turn").events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolUseId: "call_1", toolName: "bash", status: "running", input: { command: "ls" } });
    expect(tools[1]).toMatchObject({ toolUseId: "call_1", status: "ok", output: "README.md\npackage.json" });
  });

  it("settles as completed on agent_settled, not on agent_end", () => {
    const { events } = run("basic-turn");
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    // agent_end came before compaction; nothing settled there
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
  });

  it("error-turn: surfaces the extension error and settles with the provider message", () => {
    const { events } = run("error-turn");
    expect(kinds(events)).toEqual(["activity:error", "settled"]);
    expect(events.at(-1)).toEqual({ type: "settled", status: "error", error: "529 overloaded_error" });
  });

  it("settles as interrupted once marked", () => {
    const normalizer = new PiNormalizer();
    normalizer.markInterrupted();
    expect(normalizer.next({ type: "agent_settled" })).toEqual([{ type: "settled", status: "interrupted" }]);
  });

  it("beginTurn clears the previous turn's stop reason", () => {
    const normalizer = new PiNormalizer();
    normalizer.next({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    expect(normalizer.next({ type: "agent_settled" })).toEqual([{ type: "settled", status: "interrupted" }]);
    normalizer.beginTurn();
    expect(normalizer.next({ type: "agent_settled" })).toEqual([{ type: "settled", status: "completed" }]);
  });
});
