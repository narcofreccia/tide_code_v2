import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PiEntry } from "../src/turns.ts";
import type { ChildLike } from "../src/types.ts";

/**
 * A scripted stand-in for `pi --mode rpc`: real streams, real NDJSON, no process. The script
 * is a handler that receives every command line and may write events/responses back.
 */
export interface FakePi extends ChildLike {
  /** every command the driver wrote to stdin, parsed */
  readonly sent: Record<string, unknown>[];
  /** every signal `kill` was called with, oldest first */
  readonly signals: (NodeJS.Signals | undefined)[];
  /** when true, `kill` does NOT make the child exit — used to drive the SIGKILL escalation */
  ignoreSigterm: boolean;
  /** writes one NDJSON line to the driver */
  emitLine(line: Record<string, unknown>): void;
  /** writes a raw string to stdout (for framing tests) */
  writeRaw(chunk: string): void;
  exit(code: number | null): void;
}

export type Script = (command: Record<string, unknown>, pi: FakePi) => void;

export function fakePi(script: Script = () => undefined): FakePi {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const sent: Record<string, unknown>[] = [];
  const signals: (NodeJS.Signals | undefined)[] = [];
  let buffer = "";
  let exited = false;

  const pi: FakePi = {
    sent,
    signals,
    ignoreSigterm: false,
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
    kill(signal?: NodeJS.Signals) {
      signals.push(signal);
      if (pi.ignoreSigterm && signal === "SIGTERM") return true;
      pi.exit(0);
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
      if (exited) return;
      exited = true;
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
export interface BaseOverrides {
  sessionFile?: string;
  step?: number;
  contextWindow?: number;
  commands?: { name: string; source: string }[];
  /**
   * The session's entries in append order, shared with the test so its scripted turns can
   * append to it. `get_fork_messages` / `get_entries` read it and `fork` cuts it (single branch).
   */
  entries?: PiEntry[];
  /** answer `fork` with `cancelled: true`, as a `session_before_fork` handler would */
  cancelFork?: boolean;
}

export function baseScript(overrides: BaseOverrides = {}): Script {
  let sessionFile = overrides.sessionFile ?? "/tmp/pi-sessions/thread.jsonl";
  const step = overrides.step ?? 100;
  const entries = overrides.entries ?? [];
  let calls = 0;
  let forks = 0;
  return (command, pi) => {
    const id = command["id"];
    switch (command["type"]) {
      case "get_fork_messages":
        pi.emitLine({ type: "response", id, command: "get_fork_messages", success: true, data: { messages: entries.filter((entry) => entry.message?.role === "user").map((entry) => ({ entryId: entry.id, text: "x" })) } });
        return;
      case "get_entries": {
        const since = command["since"];
        const index = since === undefined ? -1 : entries.findIndex((entry) => entry.id === since);
        if (since !== undefined && index === -1) {
          pi.emitLine({ type: "response", id, command: "get_entries", success: false, error: `Entry not found: ${String(since)}` });
          return;
        }
        pi.emitLine({ type: "response", id, command: "get_entries", success: true, data: { entries: entries.slice(index + 1), leafId: entries.at(-1)?.id ?? null } });
        return;
      }
      case "fork": {
        if (overrides.cancelFork) {
          pi.emitLine({ type: "response", id, command: "fork", success: true, data: { cancelled: true } });
          return;
        }
        const index = entries.findIndex((entry) => entry.id === command["entryId"]);
        if (index === -1) {
          pi.emitLine({ type: "response", id, command: "fork", success: false, error: "Invalid entry ID for forking" });
          return;
        }
        entries.splice(index);
        forks += 1;
        sessionFile = `/tmp/pi-sessions/fork-${forks}.jsonl`;
        pi.emitLine({ type: "response", id, command: "fork", success: true, data: { text: "x", cancelled: false } });
        return;
      }
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
      case "get_commands":
        pi.emitLine({ type: "response", id, command: "get_commands", success: true, data: { commands: overrides.commands ?? [] } });
        return;
      case "abort":
        pi.emitLine({ type: "response", id, command: "abort", success: true });
        return;
      default:
        return;
    }
  };
}
