import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildLike } from "../src/types.ts";

/**
 * A scripted stand-in for `pi --mode rpc`: real streams, real NDJSON, no process. The script
 * is a handler that receives every command line and may write events/responses back.
 */
export interface FakePi extends ChildLike {
  /** every command the driver wrote to stdin, parsed */
  readonly sent: Record<string, unknown>[];
  /** writes one NDJSON line to the driver */
  emitLine(line: Record<string, unknown>): void;
  /** writes a raw string to stdout (for framing tests) */
  writeRaw(chunk: string): void;
  exit(code: number): void;
}

export type Script = (command: Record<string, unknown>, pi: FakePi) => void;

export function fakePi(script: Script = () => undefined): FakePi {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const sent: Record<string, unknown>[] = [];
  let buffer = "";

  const pi: FakePi = {
    sent,
    stdout,
    stderr,
    stdin: {
      write(chunk: string) {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index === -1) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim() === "") continue;
          const command = JSON.parse(line) as Record<string, unknown>;
          sent.push(command);
          script(command, pi);
        }
        return true;
      },
      end() {
        return undefined;
      },
    },
    kill() {
      return true;
    },
    once(event: "exit" | "error", listener: (...args: never[]) => void) {
      emitter.once(event, listener as (...args: unknown[]) => void);
      return pi;
    },
    emitLine(line) {
      stdout.write(`${JSON.stringify(line)}\n`);
    },
    writeRaw(chunk) {
      stdout.write(chunk);
    },
    exit(code) {
      emitter.emit("exit", code);
    },
  };
  return pi;
}

/**
 * Answers the driver's bookkeeping commands (`get_state`, `get_session_stats`). Token totals
 * grow by `step` on every stats call, the way a real session's cumulative counters do, so the
 * driver's per-turn delta is observable.
 */
export function baseScript(overrides: { sessionFile?: string; step?: number; contextWindow?: number } = {}): Script {
  const sessionFile = overrides.sessionFile ?? "/tmp/pi-sessions/thread.jsonl";
  const step = overrides.step ?? 100;
  let calls = 0;
  return (command, pi) => {
    const id = command["id"];
    switch (command["type"]) {
      case "get_state":
        pi.emitLine({ type: "response", id, command: "get_state", success: true, data: { sessionFile, sessionId: "abc123", model: { id: "gpt-5.5", provider: "openai" } } });
        return;
      case "get_session_stats":
        calls += 1;
        pi.emitLine({
          type: "response",
          id,
          command: "get_session_stats",
          success: true,
          data: {
            sessionFile,
            tokens: { input: step * calls, output: step * calls, cacheRead: 0, cacheWrite: 0 },
            cost: 0.01 * calls,
            contextUsage: { tokens: 1200, contextWindow: overrides.contextWindow ?? 200_000, percent: 1 },
          },
        });
        return;
      case "abort":
        pi.emitLine({ type: "response", id, command: "abort", success: true });
        return;
      default:
        return;
    }
  };
}
