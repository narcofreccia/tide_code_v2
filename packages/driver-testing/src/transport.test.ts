import { describe, expect, it } from "vitest";
import { parseTranscript } from "./frames.ts";
import { Replay, ReplayMismatchError, ReplayTransport } from "./transport.ts";

const text = (...lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join("\n");
const start = { t: "start", provider: "codex", version: "0.0.0", scenario: "unit", synthetic: true };

function one(...lines: unknown[]): { transport: ReplayTransport; delivered: unknown[]; exits: (number | null)[] } {
  const transport = Replay.fromString(text(start, ...lines)).only();
  const delivered: unknown[] = [];
  const exits: (number | null)[] = [];
  transport.attach({ deliver: (frame) => delivered.push(frame), exit: (code) => exits.push(code) });
  return { transport, delivered, exits };
}

describe("parseTranscript", () => {
  it("splits processes on proc frames and keeps the start frame", () => {
    const transcript = parseTranscript(text(start, { t: "expect_out", match: "a" }, { t: "proc", name: "probe" }, { t: "in", frame: 1 }));
    expect(transcript.start).toMatchObject({ provider: "codex", synthetic: true });
    expect(transcript.processes.map((p) => [p.name, p.frames.length])).toEqual([["main", 1], ["probe", 1]]);
  });

  it("names the first process when proc leads the file", () => {
    expect(parseTranscript(text(start, { t: "proc", name: "only" }, { t: "exit", code: 0 })).processes.map((p) => p.name)).toEqual(["only"]);
  });

  it("rejects a missing start, a double start and bad JSON with the line number", () => {
    expect(() => parseTranscript(text({ t: "exit", code: 0 }), "f.ndjson")).toThrow(/f.ndjson:1: exit before start/);
    expect(() => parseTranscript(text(start, start))).toThrow(/second start/);
    expect(() => parseTranscript(`${text(start)}\n{oops`, "g")).toThrow(/g:2: not JSON/);
    expect(() => parseTranscript("", "h")).toThrow(/no start frame/);
  });
});

describe("ReplayTransport", () => {
  it("delivers the in frames that follow a matched expect_out, up to the next expect_out", () => {
    const { transport, delivered } = one(
      { t: "expect_out", match: { method: "a" } },
      { t: "in", frame: { id: "$id", result: 1 } },
      { t: "in", frame: { method: "note" } },
      { t: "expect_out", match: { method: "b" } },
      { t: "in", frame: { id: "$id", result: 2 } },
    );
    transport.write({ id: 5, method: "a" });
    expect(delivered).toEqual([{ id: 5, result: 1 }, { method: "note" }]);
    expect(transport.remaining).toBe(1);
    transport.write({ id: 6, method: "b" });
    expect(delivered.at(-1)).toEqual({ id: 6, result: 2 });
    transport.assertDrained();
  });

  it("delivers frames the harness sends before it is spoken to when attached", () => {
    const { delivered } = one({ t: "in", frame: "hello" }, { t: "expect_out", match: "x" });
    expect(delivered).toEqual(["hello"]);
  });

  it("throws a readable diff on a mismatch and remembers it for assertDrained", () => {
    const { transport } = one({ t: "expect_out", match: { method: "turn/steer", params: { expectedTurnId: "turn-1" } } });
    expect(() => transport.write({ method: "turn/start", params: { expectedTurnId: "turn-2" } })).toThrow(ReplayMismatchError);
    try {
      transport.write({ method: "turn/start" });
    } catch (error) {
      expect(String(error)).toMatch(/\$.method: expected "turn\/steer", got "turn\/start"/);
      expect(String(error)).toMatch(/expected: \{/);
      expect(String(error)).toMatch(/actual: /);
    }
    expect(transport.errors).toHaveLength(2);
    expect(() => transport.assertDrained()).toThrow(/does not match expect_out/);
  });

  it("refuses an outbound frame when the harness should speak or the transcript is over", () => {
    const { transport } = one({ t: "in", frame: 1 });
    expect(() => transport.write({ a: 1 })).toThrow(/transcript is finished/);
    const second = one({ t: "expect_out", match: "x" }, { t: "exit", code: 1 }).transport;
    second.write("x");
    expect(() => second.write("y")).not.toThrow(); // the process exited; writes vanish
  });

  it("delivers an exit frame and reports unconsumed frames", () => {
    const { transport, exits } = one({ t: "expect_out", match: "go" }, { t: "in", frame: 1 }, { t: "exit", code: 137 });
    transport.write("go");
    expect(exits).toEqual([137]);
    expect(transport.exited).toBe(true);
    transport.assertDrained();

    const unfinished = one({ t: "expect_out", match: "one" }, { t: "expect_out", match: "two" }).transport;
    unfinished.write("one");
    expect(() => unfinished.assertDrained()).toThrow(/stopped talking/);
  });
});

describe("Replay", () => {
  it("hands out processes in order and fails on a surplus spawn", () => {
    const replay = Replay.fromString(text(start, { t: "expect_out", match: "a" }, { t: "proc", name: "second" }, { t: "expect_out", match: "b" }));
    expect(replay.next().name).toBe("main");
    expect(replay.next().name).toBe("second");
    expect(() => replay.next()).toThrow(/process #3 but the transcript only has 2/);
    expect(() => replay.assertDrained()).toThrow(/process #3/);
  });

  it("assertDrained names a process the driver never started", () => {
    const replay = Replay.fromString(text(start, { t: "proc", name: "a" }, { t: "expect_out", match: "a" }, { t: "proc", name: "b" }));
    replay.next().write("a");
    expect(() => replay.assertDrained()).toThrow(/started 1 of 2/);
  });
});
