import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { OpencodeServer, type ServerProcess, type SpawnFn } from "./server.ts";

class FakeProcess implements ServerProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signals: (NodeJS.Signals | undefined)[] = [];
  #exit: ((code: number | null) => void) | undefined;

  once(event: "exit" | "error", listener: (value: never) => void): this {
    if (event === "exit") this.#exit = listener as (code: number | null) => void;
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.exit(0);
    return true;
  }

  listening(url = "http://127.0.0.1:51234"): void {
    this.stdout.write(`Warning: OPENCODE_SERVER_PASSWORD is not set\nopencode server listening on ${url}\n`);
  }

  exit(code: number | null): void {
    this.exitCode = code;
    this.#exit?.(code);
  }
}

function harness(): { spawned: FakeProcess[]; spawn: SpawnFn; env: DriverEnv; args: string[][] } {
  const spawned: FakeProcess[] = [];
  const args: string[][] = [];
  const spawn: SpawnFn = (_command, argv) => {
    args.push(argv);
    const process = new FakeProcess();
    spawned.push(process);
    return process;
  };
  return { spawned, spawn, env: { dataDir: tmpdir(), log: () => undefined }, args };
}

describe("OpencodeServer", () => {
  it("spawns one server, parses its URL from stdout and reuses it", async () => {
    const { spawn, spawned, env, args } = harness();
    const server = new OpencodeServer({}, env, spawn);
    const pending = server.url();
    await Promise.resolve();
    spawned[0]?.listening();
    expect(await pending).toBe("http://127.0.0.1:51234");
    expect(args[0]).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"]);

    expect(await server.url()).toBe("http://127.0.0.1:51234");
    expect(spawned).toHaveLength(1);
    await server.dispose();
    expect(spawned[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("restarts a server that died between calls", async () => {
    const { spawn, spawned, env } = harness();
    const server = new OpencodeServer({}, env, spawn);
    const first = server.url();
    await Promise.resolve();
    spawned[0]?.listening("http://127.0.0.1:1111");
    await first;

    spawned[0]?.exit(1);
    const second = server.url();
    await Promise.resolve();
    spawned[1]?.listening("http://127.0.0.1:2222");
    expect(await second).toBe("http://127.0.0.1:2222");
    expect(spawned).toHaveLength(2);
    await server.dispose();
  });

  it("fails the start when the process exits before printing a URL", async () => {
    const { spawn, spawned, env } = harness();
    const server = new OpencodeServer({}, env, spawn);
    const pending = server.url();
    await Promise.resolve();
    spawned[0]?.exit(2);
    await expect(pending).rejects.toThrow(/exited with code 2/);
  });

  it("attaches to a running server instead of spawning when serverUrl is set", async () => {
    const { spawn, spawned, env } = harness();
    const server = new OpencodeServer({ serverUrl: "http://127.0.0.1:4096/" }, env, spawn);
    expect(server.external).toBe(true);
    expect(await server.url()).toBe("http://127.0.0.1:4096");
    expect(spawned).toHaveLength(0);
    await server.dispose();
  });
});
