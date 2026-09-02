import { spawn as nodeSpawn } from "node:child_process";
import type { McpServerSpec } from "@tide/contracts";
import { JsonRpcConnection, type RequestId } from "./jsonrpc.ts";
import type { ChildLike, CodexConfig, SpawnFn, TimerLike } from "./types.ts";

const CLIENT_INFO = { name: "tide", title: "Tide", version: "2.0.0" };

/** A handshake that never answers must not hang `openSession` forever. */
export const INITIALIZE_TIMEOUT_MS = 45_000;
/** How long a SIGTERM'd app-server has to exit before it is SIGKILLed. */
export const KILL_GRACE_MS = 5_000;

const REAL_TIMERS: TimerLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AppServerOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** MCP servers Tide adds on top of the user's own (see `mcpEnvAndArgs`) */
  mcpServers?: McpServerSpec[];
  spawn?: SpawnFn;
  log: (message: string) => void;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown, id: RequestId) => void;
  /** the child died on its own; whoever owns a running turn has to settle it */
  onExit?: (reason: string) => void;
  initializeTimeoutMs?: number;
  killGraceMs?: number;
  /** test seam for the handshake timeout and the SIGKILL escalation */
  timers?: TimerLike;
}

/**
 * Tide adds MCP servers through the CLI's own `-c` overrides rather than by rewriting the
 * user's config: dotted keys **merge** into the loaded `mcp_servers` table, so the user's
 * servers stay connected (verified live: `-c mcp_servers.tide.command=...` yields both).
 * The per-thread `config` map is not used for this — it is unobservable in 0.147 and
 * would risk replacing the table wholesale.
 *
 * Secrets never ride on argv (`ps` is world-readable). Codex 0.147 launches a stdio MCP
 * server with a small fixed env (HOME, LANG, LOGNAME, PATH, SHELL, TERM, TMPDIR, USER) plus
 * whatever `mcp_servers.<name>.env` sets — but `mcp_servers.<name>.env_vars` names variables
 * to forward **from the app-server's own environment** (verified live against codex 0.147).
 * So the value goes in the child's env and only the variable's *name* reaches the command
 * line. Two servers wanting different values for the same variable cannot both be forwarded;
 * the loser falls back to the visible inline form and says so in the log.
 */
export function mcpEnvAndArgs(servers: McpServerSpec[], log?: (message: string) => void): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const server of servers) {
    const key = `mcp_servers.${server.name}`;
    args.push("-c", `${key}.command=${JSON.stringify(server.command)}`);
    if (server.args && server.args.length > 0) args.push("-c", `${key}.args=[${server.args.map((a) => JSON.stringify(a)).join(", ")}]`);

    const forwarded: string[] = [];
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (env[name] === undefined || env[name] === value) {
        env[name] = value;
        forwarded.push(name);
        continue;
      }
      log?.(`[codex] ${name} is already forwarded with a different value; passing it to ${server.name} on the command line instead`);
      args.push("-c", `${key}.env.${name}=${JSON.stringify(value)}`);
    }
    if (forwarded.length > 0) args.push("-c", `${key}.env_vars=[${forwarded.map((name) => JSON.stringify(name)).join(", ")}]`);
  }
  return { args, env };
}

/** One `codex app-server` child, handshaken and ready for `thread/*` and `turn/*` calls. */
export class AppServer {
  #child: ChildLike;
  #connection: JsonRpcConnection;
  #log: (message: string) => void;
  #timers: TimerLike;
  #killGraceMs: number;
  #killTimer: unknown;
  #closed = false;
  exited = false;

  private constructor(child: ChildLike, connection: JsonRpcConnection, options: AppServerOptions) {
    this.#child = child;
    this.#connection = connection;
    this.#log = options.log;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  }

  static async start(options: AppServerOptions): Promise<AppServer> {
    const spawnFn: SpawnFn = options.spawn ?? ((command, args, opts) => nodeSpawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike);
    const mcp = mcpEnvAndArgs(options.mcpServers ?? [], options.log);
    const args = ["app-server", ...mcp.args];
    const child = spawnFn(options.binaryPath, args, { cwd: options.cwd, env: { ...options.env, ...mcp.env } });

    const connection = new JsonRpcConnection((line) => child.stdin?.write(line), {
      onNotification: (method, params) => options.onNotification?.(method, params),
      onRequest: (method, params, id) => {
        if (options.onRequest) options.onRequest(method, params, id);
        else connection.respondError(id, -32601, `tide does not handle ${method}`);
      },
      onLog: (message) => options.log(`[codex] ${message}`),
    });

    const server = new AppServer(child, connection, options);
    child.stdout?.on("data", (chunk) => connection.ingest(String(chunk)));
    child.stderr?.on("data", (chunk) => options.log(`[codex:stderr] ${String(chunk).trimEnd()}`));
    child.on("error", (error) => {
      const reason = `codex app-server failed to start: ${error instanceof Error ? error.message : String(error)}`;
      server.#onDeath(reason, options.onExit);
    });
    child.on("exit", (code) => {
      const reason = `codex app-server exited (code ${code === null || code === undefined ? "null" : String(code)})`;
      server.#onDeath(reason, options.onExit);
    });

    await server.#handshake(options);
    return server;
  }

  /**
   * The child is gone: every pending call rejects, the SIGKILL timer is pointless, and the
   * owner of a running turn is told so it can settle instead of waiting on a dead process.
   */
  #onDeath(reason: string, onExit: ((reason: string) => void) | undefined): void {
    if (this.exited) return;
    this.exited = true;
    if (this.#killTimer !== undefined) {
      this.#timers.clearTimeout(this.#killTimer);
      this.#killTimer = undefined;
    }
    this.#connection.close(reason);
    if (!this.#closed) onExit?.(reason);
  }

  /** `initialize` is the one call made before anyone is listening, so it carries its own deadline. */
  async #handshake(options: AppServerOptions): Promise<void> {
    const timeoutMs = options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    let timer: unknown;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = this.#timers.setTimeout(() => reject(new Error(`codex app-server did not answer initialize within ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([this.#connection.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } }), deadline]);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      if (timer !== undefined) this.#timers.clearTimeout(timer);
    }
    this.#connection.notify("initialized", {});
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.#connection.request<T>(method, params);
  }

  respond(id: RequestId, result: unknown): void {
    this.#connection.respond(id, result);
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.#connection.respondError(id, code, message);
  }

  /** SIGTERM, then SIGKILL if the child is still alive `killGraceMs` later. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close("codex session closed");
    if (this.exited) return;
    try {
      this.#child.kill("SIGTERM");
    } catch (error) {
      this.#log(`[codex] kill failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.exited) return;
    this.#killTimer = this.#timers.setTimeout(() => {
      this.#killTimer = undefined;
      if (this.exited) return;
      this.#log("[codex] app-server did not exit after SIGTERM; sending SIGKILL");
      try {
        this.#child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, this.#killGraceMs);
  }
}

export function mergedEnv(config: CodexConfig, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...config.env, ...extra };
}
