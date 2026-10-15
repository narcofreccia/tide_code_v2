import { readFileSync } from "node:fs";
import type { ExpectOutFrame, ProcessScript, ScriptFrame, StartFrame, Transcript } from "./frames.ts";
import { parseTranscript } from "./frames.ts";
import { matchFrame, substituteId } from "./match.ts";

/** An outbound frame did not match the transcript (or the driver talked when the harness should have). */
export class ReplayMismatchError extends Error {
  readonly process: string;
  constructor(process: string, message: string) {
    super(`[replay:${process}] ${message}`);
    this.name = "ReplayMismatchError";
    this.process = process;
  }
}

/** The driver-facing end of one replayed process: where `in` frames and the exit are delivered. */
export interface Sink {
  deliver(frame: unknown): void;
  exit(code: number | null): void;
}

function pretty(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

/**
 * Replays one process of a transcript. The driver `write()`s outbound frames; each is matched
 * against the next `expect_out`, after which every following `in` frame is delivered to the
 * sink (synchronously, in order) until the next `expect_out`, an `exit`, or the end.
 *
 * A mismatch throws from `write()` AND is remembered in `errors`, because drivers routinely
 * swallow transport exceptions; `assertDrained()` re-raises them.
 */
export class ReplayTransport {
  readonly name: string;
  readonly errors: ReplayMismatchError[] = [];
  /** every outbound frame the driver wrote, matched or not */
  readonly written: unknown[] = [];
  #frames: readonly ScriptFrame[];
  #pos = 0;
  #sink: Sink | undefined;
  #lastOut: unknown;
  #exited = false;

  constructor(script: ProcessScript) {
    this.name = script.name;
    this.#frames = script.frames;
  }

  /** Connects the driver side and delivers whatever the harness says before it is spoken to. */
  attach(sink: Sink): void {
    this.#sink = sink;
    this.#flush();
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** `expect_out` frames not yet consumed. */
  get remaining(): number {
    return this.#frames.slice(this.#pos).filter((frame) => frame.t === "expect_out").length;
  }

  #fail(message: string): never {
    const error = new ReplayMismatchError(this.name, message);
    this.errors.push(error);
    throw error;
  }

  /** The driver sent `frame` to the harness. */
  write(frame: unknown): void {
    this.written.push(frame);
    if (this.#exited) return; // a dead process swallows writes, like a closed pipe
    const next = this.#frames[this.#pos];
    if (next?.t !== "expect_out") {
      const what = next === undefined ? "the transcript is finished" : `the transcript expects the harness to ${next.t === "in" ? "speak" : "exit"} next`;
      this.#fail(`unexpected outbound frame (${what}):\n${pretty(frame)}`);
    }
    const { ok, mismatches } = matchFrame((next as ExpectOutFrame).match, frame);
    if (!ok) this.#fail(`outbound frame #${this.written.length} does not match expect_out:\n  ${mismatches.join("\n  ")}\nexpected: ${pretty((next as ExpectOutFrame).match)}\nactual:   ${pretty(frame)}`);
    this.#pos++;
    this.#lastOut = frame;
    this.#flush();
  }

  #flush(): void {
    const sink = this.#sink;
    if (!sink) return;
    for (;;) {
      const next = this.#frames[this.#pos];
      if (next === undefined || next.t === "expect_out") return;
      this.#pos++;
      if (next.t === "exit") {
        this.#exited = true;
        sink.exit(next.code);
        return;
      }
      const id = typeof this.#lastOut === "object" && this.#lastOut !== null ? (this.#lastOut as { id?: unknown }).id : undefined;
        sink.deliver(substituteId(next.frame, id));
    }
  }

  /** The driver killed or closed the process (a real one would exit); not a transcript event. */
  markExited(): void {
    this.#exited = true;
  }

  /** Throws if anything mismatched or the transcript was not played to its end. */
  assertDrained(): void {
    const first = this.errors[0];
    if (first) throw first;
    const next = this.#frames[this.#pos];
    // a trailing `exit` is optional: the driver killing the process ends it just as well
    if (next !== undefined && this.#frames.slice(this.#pos).some((frame) => frame.t !== "exit")) {
      throw new ReplayMismatchError(this.name, `the driver stopped talking before the transcript ended; next frame is ${pretty(next)} (${this.remaining} expect_out left)`);
    }
  }
}

/** All the processes of one transcript, handed out in the order the driver starts them. */
export class Replay {
  readonly transcript: Transcript;
  readonly transports: ReplayTransport[];
  #next = 0;
  readonly #errors: ReplayMismatchError[] = [];

  constructor(transcript: Transcript) {
    this.transcript = transcript;
    this.transports = transcript.processes.map((script) => new ReplayTransport(script));
  }

  static fromString(text: string, source?: string): Replay {
    return new Replay(parseTranscript(text, source));
  }

  static fromFile(path: string): Replay {
    return new Replay(parseTranscript(readFileSync(path, "utf8"), path));
  }

  get start(): StartFrame {
    return this.transcript.start;
  }

  /** The next unused process; a driver that starts more processes than were recorded fails here. */
  next(): ReplayTransport {
    const transport = this.transports[this.#next];
    if (!transport) {
      const error = new ReplayMismatchError("replay", `the driver started process #${this.#next + 1} but the transcript only has ${this.transports.length}`);
      this.#errors.push(error);
      throw error;
    }
    this.#next++;
    return transport;
  }

  /** The process an HTTP-shaped driver talks to: the whole transcript is one connection. */
  only(): ReplayTransport {
    return this.transports[0]!;
  }

  assertDrained(): void {
    const first = this.#errors[0];
    if (first) throw first;
    if (this.#next < this.transports.length && this.transports.length > 1) {
      throw new ReplayMismatchError("replay", `the driver started ${this.#next} of ${this.transports.length} recorded processes`);
    }
    for (const transport of this.transports.slice(0, Math.max(this.#next, 1))) transport.assertDrained();
  }
}
