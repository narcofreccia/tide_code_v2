import { spawn as nodeSpawn } from "node:child_process";
import type { McpServerSpec } from "@tide/contracts";
import { JsonRpcConnection, type RequestId } from "./jsonrpc.ts";
import type { ChildLike, CodexConfig, SpawnFn } from "./types.ts";

const CLIENT_INFO = { name: "tide", title: "Tide", version: "2.0.0" };

export interface AppServerOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** MCP servers Tide adds on top of the user's own (see `mcpConfigArgs`) */
  mcpServers?: McpServerSpec[];
  spawn?: SpawnFn;
  log: (message: string) => void;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown, id: RequestId) => void;
}

/**
 * Tide adds MCP servers through the CLI's own `-c` overrides rather than by rewriting the
 * user's config: dotted keys **merge** into the loaded `mcp_servers` table, so the user's
 * servers stay connected (verified live: `-c mcp_servers.tide.command=...` yields both).
 * The per-thread `config` map is not used for this — it is unobservable in 0.147 and
 * would risk replacing the table wholesale.
 */
export function mcpConfigArgs(servers: McpServerSpec[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const key = `mcp_servers.${server.name}`;
    args.push("-c", `${key}.command=${JSON.stringify(server.command)}`);
    if (server.args && server.args.length > 0) args.push("-c", `${key}.args=[${server.args.map((a) => JSON.stringify(a)).join(", ")}]`);
    for (const [name, value] of Object.entries(server.env ?? {})) args.push("-c", `${key}.env.${name}=${JSON.stringify(value)}`);
  }
  return args;
}

/** One `codex app-server` child, handshaken and ready for `thread/*` and `turn/*` calls. */
export class AppServer {
  #child: ChildLike;
  #connection: JsonRpcConnection;
  #log: (message: string) => void;
  #closed = false;
  exited = false;

  private constructor(child: ChildLike, connection: JsonRpcConnection, log: (message: string) => void) {
    this.#child = child;
    this.#connection = connection;
    this.#log = log;
  }

  static async start(options: AppServerOptions): Promise<AppServer> {
    const spawnFn: SpawnFn = options.spawn ?? ((command, args, opts) => nodeSpawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike);
    const args = ["app-server", ...mcpConfigArgs(options.mcpServers ?? [])];
    const child = spawnFn(options.binaryPath, args, { cwd: options.cwd, env: options.env });

    const connection = new JsonRpcConnection((line) => child.stdin?.write(line), {
      onNotification: (method, params) => options.onNotification?.(method, params),
      onRequest: (method, params, id) => {
        if (options.onRequest) options.onRequest(method, params, id);
        else connection.respondError(id, -32601, `tide does not handle ${method}`);
      },
      onLog: (message) => options.log(`[codex] ${message}`),
    });

    const server = new AppServer(child, connection, options.log);
    child.stdout?.on("data", (chunk) => connection.ingest(String(chunk)));
    child.stderr?.on("data", (chunk) => options.log(`[codex:stderr] ${String(chunk).trimEnd()}`));
    child.on("error", (error) => {
      server.exited = true;
      connection.close(`codex app-server failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on("exit", () => {
      server.exited = true;
      connection.close("codex app-server exited");
    });

    await connection.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } });
    connection.notify("initialized", {});
    return server;
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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close("codex session closed");
    try {
      this.#child.kill();
    } catch (error) {
      this.#log(`[codex] kill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function mergedEnv(config: CodexConfig, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...config.env, ...extra };
}
