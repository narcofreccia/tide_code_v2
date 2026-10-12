import type { DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus } from "@tide/contracts";
import { HttpOpencodeApi } from "./client.ts";
import { EventHub } from "./hub.ts";
import { OpencodeServer, type ServerSeams } from "./server.ts";
import { agentFor, OpencodeSession, type AgentChoice } from "./session.ts";
import { shellQuote } from "./shell.ts";
import { buildStatus, primaryAgents } from "./status.ts";
import type { OpencodeApi, OpencodeConfig } from "./types.ts";
import { sessionRuleset, userRules } from "./permissions.ts";
import type { ModelRef, WireAgent, WireConfigEntry, WireModel, WireTokens } from "./wire.ts";

const STATUS_TTL_MS = 60_000;
const CATALOG_TTL_MS = 60_000;
/** instruction entry key Tide owns on a session (`InstructionEntry.Key`: `^[a-z0-9][a-z0-9._-]*$`) */
export const INSTRUCTION_KEY = "tide";

/** `provider/model`; the model id itself may contain slashes (`openrouter/anthropic/x`). */
export function parseModelId(id: string): ModelRef | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1) };
}

/**
 * Thread-scoped MCP registration name: registrations are per location on a shared server, so
 * two threads on one cwd registering plain "tide" would leave one live server holding
 * whichever agent token registered last.
 */
export function mcpServerName(serverName: string, threadId: string): string {
  return `${serverName}-${threadId}`;
}

/**
 * Agents for a directory: `plan` for plan mode, and for everything else the user's default
 * primary agent. `GET /api/agent` lists the selected default first (core 2.0.27
 * `Agent.list`: `[selectedDefault, ...rest]`, honouring `default_agent`), so custom primary
 * agents and `default_agent` are respected without Tide reading config itself.
 */
export function chooseAgents(agents: WireAgent[]): AgentChoice {
  const primary = primaryAgents(agents);
  const build = primary.find((agent) => agent.id !== "plan")?.id ?? "build";
  const plan = agents.find((agent) => agent.id === "plan")?.id;
  return { build, ...(plan !== undefined ? { plan } : {}) };
}

export class OpencodeInstance implements ProviderInstance {
  readonly kind = "opencode" as const;

  #config: OpencodeConfig;
  #env: DriverEnv;
  #server: OpencodeServer;
  #hub: EventHub;
  #api: OpencodeApi | undefined;
  #apiUrl: string | undefined;
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #catalog = new Map<string, { at: number; value: WireModel[] }>();
  #sessions = new Set<OpencodeSession>();

  constructor(config: OpencodeConfig, env: DriverEnv, seams: ServerSeams = {}) {
    this.#config = config;
    this.#env = env;
    this.#server = new OpencodeServer(config, env, seams);
    this.#hub = new EventHub(() => this.api(), (msg) => env.log(msg), () => this.#server.invalidate());
  }

  /** Resolves the endpoint (shared service, configured URL or private server) and a client for it. */
  async api(): Promise<OpencodeApi> {
    if (this.#config.apiImpl) return this.#config.apiImpl;
    const endpoint = await this.#server.endpoint();
    if (this.#api === undefined || this.#apiUrl !== endpoint.url) {
      this.#api = new HttpOpencodeApi(endpoint);
      this.#apiUrl = endpoint.url;
    }
    return this.#api;
  }

  async status(): Promise<ProviderStatus> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= buildStatus(this.#config, this.#env, async () => {
      const api = await this.api();
      const version = this.#server.current?.version;
      return { api, directory: process.cwd(), ...(version !== undefined ? { version } : {}) };
    })
      .then((value) => {
        this.#status = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#statusInFlight = undefined;
      });
    return this.#statusInFlight;
  }

  async #models(directory: string): Promise<WireModel[]> {
    const cached = this.#catalog.get(directory);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const value = await (await this.api()).models({ directory });
    this.#catalog.set(directory, { at: Date.now(), value });
    return value;
  }

  /** No pinned model → the session uses OpenCode's own default (agent model / `model` config). */
  async #resolveModel(directory: string, requested: string | undefined): Promise<{ model?: ModelRef; contextWindow?: number }> {
    const id = requested ?? this.#config.defaultModel;
    let catalog: WireModel[] = [];
    try {
      catalog = await this.#models(directory);
    } catch (error) {
      this.#env.log(`[opencode] model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const model = id === undefined ? undefined : parseModelId(id);
    if (model === undefined) {
      const fallback = await (await this.api()).defaultModel({ directory }).catch(() => undefined);
      if (fallback === undefined) return {};
      const window = fallback.limit?.context;
      return typeof window === "number" && window > 0 ? { contextWindow: window } : {};
    }
    const window = catalog.find((entry) => entry.providerID === model.providerID && entry.id === model.id)?.limit?.context;
    return { model, ...(typeof window === "number" && window > 0 ? { contextWindow: window } : {}) };
  }

  /** Best-effort reads: an unreadable config or agent list must never stop a thread from opening. */
  async #directoryContext(api: OpencodeApi, directory: string): Promise<{ config: WireConfigEntry[]; agents: AgentChoice }> {
    const [config, agents] = await Promise.all([
      api.config({ directory }).catch((error: unknown) => {
        this.#env.log(`[opencode] could not read the user's config: ${error instanceof Error ? error.message : String(error)}`);
        return [] as WireConfigEntry[];
      }),
      api.agents({ directory }).catch(() => [] as WireAgent[]),
    ]);
    return { config, agents: chooseAgents(agents) };
  }

  async openSession(options: OpenSessionOptions): Promise<ProviderSession> {
    const api = await this.api();
    const { config, agents } = await this.#directoryContext(api, options.cwd);
    const { model, contextWindow } = await this.#resolveModel(options.cwd, options.model);
    const agent = agentFor(agents, options.interaction);
    if (options.interaction === "plan" && agents.plan === undefined) this.#env.log("[opencode] no `plan` agent on this server; plan turns run on the default agent");

    let sessionId = options.resume;
    let baseline: { cost: number; tokens: WireTokens } | undefined;
    const permissions = sessionRuleset(options.mode, options.interaction, options.cwd, options.linkedDirs ?? [], userRules(config, agent));
    if (sessionId === undefined) {
      const created = await api.createSession({
        directory: options.cwd,
        title: `Tide ${options.threadId}`,
        agent,
        ...(model ? { model } : {}),
        permissions,
        metadata: { tideThreadId: options.threadId },
      });
      sessionId = created.id;
    } else {
      // v2 changes all of these in place, so a resumed session follows the thread's current settings
      const existing = await api.getSession({ sessionId });
      baseline = { cost: existing.cost, tokens: existing.tokens };
      await api.setPermissions({ sessionId, permissions });
      if (existing.agent !== agent) await api.switchAgent({ sessionId, agent });
      if (model && (existing.model?.id !== model.id || existing.model.providerID !== model.providerID)) await api.switchModel({ sessionId, model });
    }

    if (options.systemPromptAppend !== undefined) {
      await api.putInstruction({ sessionId, key: INSTRUCTION_KEY, value: options.systemPromptAppend }).catch((error: unknown) => {
        this.#env.log(`[opencode] could not attach Tide's instructions: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const mcpNames: string[] = [];
    for (const server of options.mcpServers) {
      const name = mcpServerName(server.name, options.threadId);
      try {
        await api.addMcpServer({ directory: options.cwd, name, command: [server.command, ...(server.args ?? [])], ...(server.env ? { env: server.env } : {}) });
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
        hub: this.#hub,
        agents,
        config,
        ...(model ? { model } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(baseline ? { baseline } : {}),
        ...(mcpNames.length > 0 ? { mcpNames } : {}),
        resolveModel: (id) => this.#resolveModel(options.cwd, id),
        onClosed: (closed) => this.#sessions.delete(closed),
      },
      sessionId,
    );
    this.#sessions.add(session);
    return session;
  }

  /**
   * `opencode --session <id>` (2.0.27 `--help`: "Session ID to continue"). With no `--server`
   * it attaches to the shared background service, which reads the same session database a
   * private `opencode serve` writes. A configured `binaryPath` is used verbatim, since the
   * `opencode` on PATH may still be 1.x.
   */
  terminalCommand(nativeSessionId: string, cwd: string): string {
    const binary = this.#config.binaryPath !== undefined ? shellQuote(this.#config.binaryPath) : "opencode";
    return `cd ${shellQuote(cwd)} && ${binary} --session ${shellQuote(nativeSessionId)}`;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
    await this.#hub.close();
    await this.#server.dispose();
  }
}
