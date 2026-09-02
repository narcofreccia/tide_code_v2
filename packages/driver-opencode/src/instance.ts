import type { DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus } from "@tide/contracts";
import { SdkOpencodeApi } from "./client.ts";
import { sessionRuleset } from "./permissions.ts";
import { OpencodeServer, type SpawnFn } from "./server.ts";
import { OpencodeSession } from "./session.ts";
import { shellQuote } from "./shell.ts";
import { buildStatus } from "./status.ts";
import type { ModelRef, OpencodeApi, OpencodeConfig } from "./types.ts";
import type { WireProvider } from "./wire.ts";

const STATUS_TTL_MS = 60_000;
const CATALOG_TTL_MS = 60_000;

/** `provider/model`; the model id itself may contain slashes (`openrouter/anthropic/x`). */
export function parseModelId(id: string): ModelRef | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/**
 * Thread-scoped MCP registration name. opencode exposes MCP tools to the model as
 * `<serverName with non-alphanumerics replaced by _>_<toolName>`, so this also renames the
 * tools (`tide-<threadId>_tide_delegate`). Every server registered for a directory is
 * visible to every session in that directory, so sibling threads sharing a cwd do see each
 * other's tide tools — but each one keeps its own token, which the single shared name could
 * not do (see docs/internals/providers.md).
 */
export function mcpServerName(serverName: string, threadId: string): string {
  return `${serverName}-${threadId}`;
}

export class OpencodeInstance implements ProviderInstance {
  readonly kind = "opencode" as const;

  #config: OpencodeConfig;
  #env: DriverEnv;
  #server: OpencodeServer;
  #api: OpencodeApi | undefined;
  #apiUrl: string | undefined;
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #catalog: { at: number; value: { providers: WireProvider[]; default: Record<string, string> } } | undefined;
  #sessions = new Set<OpencodeSession>();

  constructor(config: OpencodeConfig, env: DriverEnv, spawn?: SpawnFn) {
    this.#config = config;
    this.#env = env;
    this.#server = new OpencodeServer(config, env, spawn);
  }

  /** Spawns (or reuses) the instance's server and returns a client bound to its URL. */
  async api(): Promise<OpencodeApi> {
    if (this.#config.apiImpl) return this.#config.apiImpl;
    const url = await this.#server.url();
    if (this.#api === undefined || this.#apiUrl !== url) {
      this.#api = new SdkOpencodeApi(url);
      this.#apiUrl = url;
    }
    return this.#api;
  }

  async status(): Promise<ProviderStatus> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= buildStatus(this.#config, this.#env, async () => ({ api: await this.api(), directory: process.cwd() }))
      .then((value) => {
        this.#status = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#statusInFlight = undefined;
      });
    return this.#statusInFlight;
  }

  async #providers(): Promise<{ providers: WireProvider[]; default: Record<string, string> }> {
    const cached = this.#catalog;
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const api = await this.api();
    const value = await api.providers();
    this.#catalog = { at: Date.now(), value };
    return value;
  }

  async #resolveModel(requested: string | undefined): Promise<{ model?: ModelRef; contextWindow?: number }> {
    const id = requested ?? this.#config.defaultModel;
    let catalog: { providers: WireProvider[]; default: Record<string, string> } | undefined;
    try {
      catalog = await this.#providers();
    } catch (error) {
      this.#env.log(`[opencode] provider catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const model = id === undefined ? undefined : parseModelId(id);
    if (model === undefined) return {};
    const window = catalog?.providers.find((provider) => provider.id === model.providerID)?.models[model.modelID]?.limit?.context;
    return { model, ...(typeof window === "number" && window > 0 ? { contextWindow: window } : {}) };
  }

  async openSession(options: OpenSessionOptions): Promise<ProviderSession> {
    const api = await this.api();
    const agent = options.interaction === "plan" ? "plan" : "build";
    const { model, contextWindow } = await this.#resolveModel(options.model);

    let sessionId = options.resume;
    if (sessionId === undefined) {
      const created = await api.createSession({
        directory: options.cwd,
        title: `Tide ${options.threadId}`,
        permission: sessionRuleset(options.mode, options.interaction, options.cwd, options.linkedDirs ?? []),
      });
      sessionId = created.id;
    } else {
      // opencode stores the permission ruleset on the session at creation and `PATCH /session`
      // only takes a title, so a resumed session keeps the mode it was opened with.
      this.#env.log(`[opencode] resuming ${sessionId}; its original permission ruleset still applies`);
    }

    // MCP registrations are keyed by name on the shared per-directory server, and `POST /mcp`
    // *replaces* an existing entry of the same name. Two threads on one cwd registering plain
    // "tide" would leave one live server holding whichever agent token registered last — the
    // other thread would then act under a foreign identity. The thread id makes them distinct.
    const mcpNames: string[] = [];
    for (const server of options.mcpServers) {
      const name = mcpServerName(server.name, options.threadId);
      try {
        await api.addMcpServer({
          directory: options.cwd,
          name,
          command: [server.command, ...(server.args ?? [])],
          ...(server.env ? { env: server.env } : {}),
        });
        mcpNames.push(name);
      } catch (error) {
        this.#env.log(`[opencode] could not register MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const session = new OpencodeSession(
      this.#env,
      options,
      {
        api,
        agent,
        ...(model ? { model } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(mcpNames.length > 0 ? { mcpNames } : {}),
        onClosed: (closed) => this.#sessions.delete(closed),
      },
      sessionId,
    );
    this.#sessions.add(session);
    return session;
  }

  terminalCommand(nativeSessionId: string, cwd: string): string {
    return `cd ${shellQuote(cwd)} && opencode --session ${shellQuote(nativeSessionId)}`;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
    await this.#server.dispose();
  }
}
