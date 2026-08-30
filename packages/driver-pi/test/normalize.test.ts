import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { PiNormalizer } from "../src/index.ts";
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
      "assistant.delta",
      "assistant.delta",
      "activity:tool", // bash running
      "activity:tool", // bash ok
      "assistant.delta",
      "activity:info", // compaction start
      "activity:info", // compaction end
      "settled",
    ]);
    expect(unknown).toBe(1); // only `totally_new_event`
  });

  it("keeps thinking out of the assistant message and separates the two messages", () => {
    const { events } = run("basic-turn");
    const deltas = events.flatMap((event) => (event.type === "assistant.delta" ? [event] : []));
    expect(deltas.map((delta) => delta.delta).join("")).toBe("Listing the files.Two files.");
    expect(deltas.map((delta) => delta.delta).join("")).not.toContain("secret");
    expect(deltas[0]?.messageKey).toBe(deltas[1]?.messageKey);
    expect(deltas[2]?.messageKey).not.toBe(deltas[0]?.messageKey);
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

  it("settles as interrupted once marked, and ignores unknown frames", () => {
    const normalizer = new PiNormalizer();
    normalizer.markInterrupted();
    expect(normalizer.next({ type: "brand_new" })).toEqual([]);
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
