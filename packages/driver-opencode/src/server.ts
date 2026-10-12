import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverEnv } from "@tide/contracts";
import { assertV2, binaryVersion, detectBinary, majorOf } from "./binary.ts";
import { authHeader, type Endpoint } from "./client.ts";
import type { OpencodeConfig } from "./types.ts";

const START_TIMEOUT_MS = 45_000;
const KILL_GRACE_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
const LISTENING = /listening on\s+(https?:\/\/\S+)/i;
const PASSWORD = /server password\s+(\S+)/i;

export interface ServerProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ServerProcess;

export interface ResolvedEndpoint extends Endpoint {
  /** `configured` = `serverUrl`; `service` = the user's shared background service; `spawned` = Tide's private server */
  source: "configured" | "service" | "spawned";
  version?: string;
}

/** Test seams; production uses `child_process.spawn`, `discoverService` and a 5 s kill grace. */
export interface ServerSeams {
  spawn?: SpawnFn;
  discover?: DiscoverFn;
  killGraceMs?: number;
}

export type DiscoverFn = (file: string) => Promise<(Endpoint & { version: string }) | undefined>;

/** `@opencode/client` `fallback()`: `$XDG_STATE_HOME/opencode/service.json`. */
export function serviceFile(config: OpencodeConfig): string {
  return config.serviceFile ?? join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json");
}

/**
 * Finds the user's running shared service the way `@opencode/client`'s `Service.discover`
 * does: read the registration file (`{ id, version, url, pid, password }`), ask
 * `GET /api/info` with Basic `opencode:<password>`, and trust it only when the answering pid
 * and version match the registration. Never starts one.
 */
export const discoverService: DiscoverFn = async (file) => {
  let info: { url?: unknown; pid?: unknown; version?: unknown; password?: unknown };
  try {
    info = JSON.parse(await readFile(file, "utf8")) as typeof info;
  } catch {
    return undefined;
  }
  if (typeof info.url !== "string" || typeof info.pid !== "number") return undefined;
  const endpoint: Endpoint = { url: info.url.replace(/\/$/, ""), ...(typeof info.password === "string" ? { password: info.password } : {}) };
  try {
    const response = await fetch(`${endpoint.url}/api/info`, { headers: authHeader(endpoint), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const answer = (await response.json()) as { pid?: unknown; version?: unknown };
    if (answer.pid !== info.pid || typeof answer.version !== "string") return undefined;
    if (typeof info.version === "string" && info.version !== answer.version) return undefined;
    return { ...endpoint, version: answer.version };
  } catch {
    return undefined;
  }
};

/**
 * Where this driver instance talks to OpenCode 2. In order:
 *  1. `serverUrl` (+ `serverPassword`) when configured;
 *  2. the user's shared background service (`opencode service`), when it is running — the
 *     non-crippling default: same sessions, config and auth the user's TUI sees;
 *  3. otherwise one private `opencode serve` per driver instance, spawned with a random
 *     `OPENCODE_SERVER_PASSWORD` (verified: with it set, every route — `/api/info` included —
 *     answers 401 without Basic auth) and torn down with SIGTERM, then SIGKILL.
 * v2 sessions carry their own `location.directory`, so one server serves every worktree.
 */
export class OpencodeServer {
  #config: OpencodeConfig;
  #env: DriverEnv;
  #spawn: SpawnFn;
  #discover: DiscoverFn;
  #child: ServerProcess | undefined;
  #endpoint: ResolvedEndpoint | undefined;
  #starting: Promise<ResolvedEndpoint> | undefined;
  #disposed = false;
  #killGraceMs: number;

  constructor(config: OpencodeConfig, env: DriverEnv, seams: ServerSeams = {}) {
    this.#config = config;
    this.#env = env;
    this.#spawn = seams.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.#discover = seams.discover ?? discoverService;
    this.#killGraceMs = seams.killGraceMs ?? KILL_GRACE_MS;
  }

  /** The current endpoint, if one was resolved (used for the terminal escape hatch). */
  get current(): ResolvedEndpoint | undefined {
    return this.#endpoint;
  }

  /** Resolves (and caches) the endpoint; re-resolves after `invalidate()` or a dead child. */
  async endpoint(): Promise<ResolvedEndpoint> {
    if (this.#disposed) throw new Error("opencode server is disposed");
    const cached = this.#endpoint;
    if (cached && (cached.source !== "spawned" || this.#child?.exitCode === null)) return cached;
    if (cached) this.#env.log("[opencode] private server exited; restarting");
    this.#starting ??= this.#resolve().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /** Forget an attached endpoint (its event stream died) so the next call looks again. */
  invalidate(): void {
    if (this.#endpoint?.source !== "spawned") this.#endpoint = undefined;
  }

  async #resolve(): Promise<ResolvedEndpoint> {
    if (this.#config.serverUrl !== undefined) {
      this.#endpoint = {
        source: "configured",
        url: this.#config.serverUrl.replace(/\/$/, ""),
        ...(this.#config.serverPassword !== undefined ? { password: this.#config.serverPassword } : {}),
      };
      return this.#endpoint;
    }
    if (this.#config.attach !== "standalone") {
      const found = await this.#discover(serviceFile(this.#config));
      if (found && (majorOf(found.version) ?? 0) >= 2) {
        this.#env.log(`[opencode] attached to the shared service at ${found.url} (v${found.version})`);
        this.#endpoint = { source: "service", ...found };
        return this.#endpoint;
      }
    }
    this.#endpoint = await this.#start();
    return this.#endpoint;
  }

  async #start(): Promise<ResolvedEndpoint> {
    const binary = await detectBinary(this.#config);
    if (binary === undefined) throw new Error("opencode is not installed (no `opencode` on PATH)");
    const version = await binaryVersion(binary);
    assertV2(version);
    const password = randomBytes(24).toString("base64url");
    const child = this.#spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: process.cwd(),
      env: { ...process.env, ...this.#config.env, OPENCODE_SERVER_PASSWORD: password },
    });
    this.#child = child;

    const started = await new Promise<{ url: string; printed?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve did not print a URL within ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS);
      timer.unref?.();
      let buffer = "";
      const finish = (error: Error | undefined, url?: string): void => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ url: url!, ...(PASSWORD.exec(buffer)?.[1] ? { printed: PASSWORD.exec(buffer)![1]! } : {}) });
      };
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

    this.#env.log(`[opencode] private server listening on ${started.url}`);
    // a build that ignores OPENCODE_SERVER_PASSWORD prints its own generated one instead
    return { source: "spawned", url: started.url, password: started.printed ?? password, ...(version !== undefined ? { version } : {}) };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const child = this.#child;
    this.#child = undefined;
    this.#endpoint = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#killGraceMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([exited.then(() => "exited" as const), grace]);
    clearTimeout(timer);
    if (outcome === "timeout" && child.exitCode === null) child.kill("SIGKILL");
  }
}
