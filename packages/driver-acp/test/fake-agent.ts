import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildLike, JsonRpcMessage, SpawnLike } from "../src/types.ts";

/**
 * A fake ACP agent process for the `spawn` seam, driven by ndjson fixtures.
 *
 * Fixture lines are JSON-RPC messages; lines the CLIENT sent carry `"_dir":"c2a"`. The agent is
 * compiled into scripts keyed by the client message that triggers them: a client request
 * (`req:<method>`), a client response to an agent request (`res:<id>`) or a client notification
 * (`note:<method>`). When the driver sends a matching message, the agent lines up to the next
 * client line are emitted, with the fixture's response ids remapped to the driver's live ids.
 * A client request no fixture covers gets `{}` (recorded in `extras`). `<CWD>` in a fixture is
 * replaced with the session cwd.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type FixtureLine = JsonRpcMessage & { _dir?: "c2a"; _header?: unknown };

export function loadFixture(name: string, cwd = "/repo"): FixtureLine[] {
  return readFileSync(join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line.replaceAll("<CWD>", cwd)) as FixtureLine)
    .filter((line) => line._header === undefined);
}

/** Synchronous stand-in for a Readable that never re-enters its own `data` handler. */
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
}

export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new OutStream();
  readonly stderr = new OutStream();
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  /** every message the driver wrote, parsed */
  readonly received: JsonRpcMessage[] = [];
  onClient: (message: JsonRpcMessage) => void = () => undefined;
  stdinEnded = false;
  #buffer = "";
  #exited = false;

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.#buffer += chunk;
      for (let index = this.#buffer.indexOf("\n"); index >= 0; index = this.#buffer.indexOf("\n")) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        const message = JSON.parse(line) as JsonRpcMessage;
        this.received.push(message);
        this.onClient(message);
      }
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  send(message: JsonRpcMessage): void {
    this.stdout.push(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  /** raw stdout text (non-JSON lines) */
  print(text: string): void {
    this.stdout.push(text);
  }

  override once(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.exit(null, signal ?? "SIGTERM");
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.emit("exit", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

function keyOf(line: FixtureLine): string {
  if (line.method !== undefined) return line.id === undefined || line.id === null ? `note:${line.method}` : `req:${line.method}`;
  return `res:${String(line.id)}`;
}

export class FixtureAgent {
  readonly child = new FakeChild();
  /** client requests no fixture script covered */
  readonly extras: JsonRpcMessage[] = [];
  /** client responses that differed from what the fixture expected */
  readonly mismatches: { expected: unknown; actual: unknown }[] = [];
  #scripts = new Map<string, { trigger: FixtureLine; lines: FixtureLine[] }[]>();
  #ids = new Map<string, number | string>();

  constructor(lines: FixtureLine[]) {
    let current: FixtureLine[] | undefined;
    for (const line of lines) {
      if (line._dir === "c2a") {
        const key = keyOf(line);
        current = [];
        const queue = this.#scripts.get(key) ?? [];
        queue.push({ trigger: line, lines: current });
        this.#scripts.set(key, queue);
      } else if (current) current.push(line);
    }
    this.child.onClient = (message) => this.#client(message);
  }

  #client(message: JsonRpcMessage): void {
    const key = keyOf(message as FixtureLine);
    const script = this.#scripts.get(key)?.shift();
    if (!script) {
      if (message.method !== undefined && message.id !== undefined && message.id !== null) {
        this.extras.push(message);
        this.child.send({ id: message.id, result: {} });
      }
      return;
    }
    if (message.method !== undefined && message.id !== undefined && message.id !== null && script.trigger.id !== undefined && script.trigger.id !== null) {
      this.#ids.set(String(script.trigger.id), message.id);
    }
    if (message.method === undefined) {
      const expected = script.trigger.error ? { error: { code: script.trigger.error.code } } : { result: script.trigger.result };
      const actual = message.error ? { error: { code: message.error.code } } : { result: message.result };
      if (JSON.stringify(expected) !== JSON.stringify(actual)) this.mismatches.push({ expected, actual });
    }
    for (const line of script.lines) {
      const { _dir: _ignored, ...out } = line;
      const isResponse = out.method === undefined && out.id !== undefined && out.id !== null;
      this.child.send(isResponse ? { ...out, id: this.#ids.get(String(out.id)) ?? out.id ?? null } : out);
    }
  }

  spawn: SpawnLike = () => this.child;
}

/** A spawn seam that hands out the given children in order and records the calls. */
export function spawnSeq(...children: ChildLike[]): SpawnLike & { calls: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] } {
  const calls: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const spawn = ((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, ...options });
    const child = children.shift();
    if (!child) throw new Error("spawnSeq: no more children");
    return child;
  }) as SpawnLike & { calls: typeof calls };
  spawn.calls = calls;
  return spawn;
}
