import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { jsonSafe, type Recorder } from "./recorder.ts";
import type { Replay, ReplayTransport } from "./transport.ts";

/**
 * Stdio-JSONL transports (Codex app-server JSON-RPC, Pi `--mode rpc`): a fake child process
 * whose stdin lines are matched against the transcript and whose stdout is the `in` frames.
 *
 * The child satisfies both drivers' structural `ChildLike` types, so it is returned from the
 * `spawnImpl` / `PiDeps.spawn` seams as-is.
 */

/**
 * Synchronous stand-in for a Readable: `on("data" | "end")` is all either driver uses.
 * A chunk pushed while another is being handled (the driver answered a line from inside its
 * own handler) is queued, never re-entered: real streams do not nest `data` events and line
 * splitters such as Pi's `readJsonl` rely on that.
 */
class OutStream extends EventEmitter {
  #queue: string[] = [];
  #emitting = false;

  push(chunk: string): void {
    this.#queue.push(chunk);
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) this.emit("data", next);
    } finally {
      this.#emitting = false;
    }
  }
  end(): void {
    this.emit("end");
  }
}

export interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class ReplayChild extends EventEmitter {
  readonly stdout = new OutStream();
  readonly stderr = new OutStream();
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  readonly call: SpawnCall;
  readonly transport: ReplayTransport;
  #buffer = "";
  #exited = false;
  /** when true, `kill` does not end the process (drives SIGKILL escalation tests) */
  ignoreSigterm = false;

  constructor(transport: ReplayTransport, call: SpawnCall) {
    super();
    this.transport = transport;
    this.call = call;
    transport.attach({
      deliver: (frame) => this.stdout.push(`${JSON.stringify(frame)}\n`),
      exit: (code) => this.#exit(code),
    });
  }

  readonly stdin = {
    write: (chunk: string | Uint8Array): boolean => {
      this.#buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (;;) {
        const index = this.#buffer.indexOf("\n");
        if (index < 0) return true;
        const line = this.#buffer.slice(0, index).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() === "") continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          frame = line; // not JSON: matched as a string
        }
        this.transport.write(frame);
      }
    },
    end: (): void => undefined,
  };

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.ignoreSigterm && signal === "SIGTERM") return true;
    this.transport.markExited();
    this.#exit(0);
    return true;
  }

  #exit(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code);
  }
}

export type ReplaySpawn = ((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ReplayChild) & {
  readonly children: ReplayChild[];
};

/** A `spawn` seam that hands out the transcript's processes in order, one per call. */
export function replaySpawn(replay: Replay): ReplaySpawn {
  const children: ReplayChild[] = [];
  const spawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ReplayChild => {
    const child = new ReplayChild(replay.next(), { command, args, cwd: options.cwd, env: options.env });
    children.push(child);
    return child;
  };
  return Object.assign(spawn, { children });
}

// ---- recording ----

/** The slice of a child process both drivers use; what `recordSpawn` wraps and returns. */
export interface RecordableChild {
  stdin: { write(chunk: string): unknown; end?(): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): unknown;
  on?(event: "exit", listener: (code: number | null) => void): unknown;
  once?(event: "exit", listener: (code: number | null) => void): unknown;
}

/** Splits a byte stream into complete lines. */
function lineTap(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") onLine(line);
    }
  };
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

/**
 * Wraps a real `spawn`: traffic passes through untouched while every stdin line is recorded as
 * `expect_out` and every stdout line as `in`. Tap listeners attach before the driver's, so a
 * harness line is recorded before the driver's reaction to it.
 */
export function recordSpawn<Child extends RecordableChild>(spawn: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Child, recorder: Recorder) {
  return (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Child => {
    const child = spawn(command, args, options);
    recorder.proc();
    child.stdout?.on("data", lineTap((line) => recorder.in(jsonSafe(parseLine(line)))));
    const stdin = child.stdin;
    if (stdin) {
      const write = stdin.write.bind(stdin);
      const tap = lineTap((line) => recorder.out(jsonSafe(parseLine(line))));
      stdin.write = (chunk: string): unknown => {
        tap(chunk);
        return write(chunk);
      };
    }
    const onExit = (code: number | null): void => recorder.exit(code ?? null);
    if (child.on) child.on("exit", onExit);
    else child.once?.("exit", onExit);
    return child;
  };
}
