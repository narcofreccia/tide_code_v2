import { spawn as nodeSpawn } from "node:child_process";
import type { DriverEnv } from "@tide/contracts";
import { detectBinary } from "./binary.ts";
import type { OpencodeConfig } from "./types.ts";

const START_TIMEOUT_MS = 45_000;
const LISTENING = /listening on\s+(https?:\/\/\S+)/i;

export interface ServerProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ServerProcess;

/**
 * One managed `opencode serve` per driver instance — not per session and not per worktree.
 *
 * opencode's server is *not* bound to the directory it was started in: every route takes a
 * `?directory=` query parameter, and sessions carry their own `directory`. Verified against
 * opencode 1.1.36: a server started in `/tmp` creates a session whose directory is another
 * repository and runs its tools there. Sessions are cheap objects on that one server, so a
 * per-cwd server map would only multiply processes.
 */
export class OpencodeServer {
  #config: OpencodeConfig;
  #env: DriverEnv;
  #spawn: SpawnFn;
  #child: ServerProcess | undefined;
  #url: string | undefined;
  #starting: Promise<string> | undefined;
  #disposed = false;

  constructor(config: OpencodeConfig, env: DriverEnv, spawn: SpawnFn = nodeSpawn as unknown as SpawnFn) {
    this.#config = config;
    this.#env = env;
    this.#spawn = spawn;
  }

  /** true when this instance attached to a server the user (or a test) already runs */
  get external(): boolean {
    return this.#config.serverUrl !== undefined;
  }

  /** Spawns on first use and re-spawns if the process died since the last call. */
  async url(): Promise<string> {
    if (this.#disposed) throw new Error("opencode server is disposed");
    if (this.#config.serverUrl !== undefined) return this.#config.serverUrl.replace(/\/$/, "");
    if (this.#url !== undefined && this.#child?.exitCode === null) return this.#url;
    if (this.#url !== undefined) this.#env.log("[opencode] server exited; restarting");
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<string> {
    const binary = await detectBinary(this.#config);
    if (binary === undefined) throw new Error("opencode is not installed (no `opencode` on PATH)");
    const child = this.#spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: process.cwd(),
      env: { ...process.env, ...this.#config.env },
    });
    this.#child = child;
    this.#url = undefined;

    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve did not print a URL within ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS);
      timer.unref?.();
      const finish = (error: Error | undefined, value?: string): void => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value!);
      };
      let buffer = "";
      const onData = (chunk: Buffer | string): void => {
        buffer += String(chunk);
        const match = LISTENING.exec(buffer);
        if (match?.[1]) finish(undefined, match[1].replace(/\/$/, ""));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk: Buffer | string) => {
        onData(chunk);
        this.#env.log(`[opencode:stderr] ${String(chunk).trimEnd()}`);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`opencode serve exited with code ${code ?? "null"}`)));
    });

    this.#url = url;
    this.#env.log(`[opencode] server listening on ${url}`);
    return url;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const child = this.#child;
    this.#child = undefined;
    this.#url = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
  }
}
