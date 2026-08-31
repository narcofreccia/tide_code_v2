import type { DriverEnv, ModelInfo, ProviderStatus } from "@tide/contracts";
import { detectBinary, exec, parseVersion } from "./binary.ts";
import type { OpencodeApi, OpencodeConfig } from "./types.ts";
import type { WireAgent, WireProvider } from "./wire.ts";

export const LOGIN_HINT = "Run `opencode auth login` in a terminal";
export const INSTALL_HINT = "Install opencode: https://opencode.ai";

/**
 * Baseline capabilities. `planMode` and `subagents` are confirmed against the running
 * server's `/agent` catalog (the `plan` agent and any `mode: "subagent"` agents), so a
 * build without them reports them off rather than lying.
 *
 * - `mcp`: `POST /mcp` registers a server for a directory at runtime, so Tide's own MCP
 *   server is added per worktree without touching the user's `opencode.json`.
 * - `images`: prompt parts accept `{ type: "file", mime, url }`, and Tide passes images as
 *   `data:` URLs.
 * - `contextUsage`: assistant messages carry `tokens`, the catalog carries `limit.context`.
 */
export const OPENCODE_CAPS = {
  planMode: true,
  subagents: true,
  mcp: true,
  images: true,
  resume: true,
  contextUsage: true,
  openInTerminal: true,
} as const;

export function toModelInfo(providers: WireProvider[], defaults: Record<string, string>, pinned: string | undefined): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const provider of providers) {
    for (const model of Object.values(provider.models)) {
      const id = `${provider.id}/${model.id}`;
      const isDefault = pinned !== undefined ? id === pinned : defaults[provider.id] === model.id;
      models.push({ id, label: model.name ?? model.id, family: provider.id, ...(isDefault ? { default: true } : {}) });
    }
  }
  return models;
}

export function capsFor(agents: WireAgent[]): ProviderStatus["caps"] {
  if (agents.length === 0) return { ...OPENCODE_CAPS };
  return {
    ...OPENCODE_CAPS,
    planMode: agents.some((agent) => agent.name === "plan"),
    subagents: agents.some((agent) => agent.mode === "subagent" || agent.mode === "all"),
  };
}

export interface StatusProbe {
  api: OpencodeApi;
  directory: string;
}

/**
 * Login is decided by the server's own provider catalog: `GET /config/providers` only lists
 * providers opencode can actually use (credentials in `auth.json`, an API key in the env or
 * a configured custom provider). No catalog entry means no usable model.
 */
export async function buildStatus(config: OpencodeConfig, env: DriverEnv, probe: () => Promise<StatusProbe>): Promise<ProviderStatus> {
  const binary = await detectBinary(config);
  if (binary === undefined && config.serverUrl === undefined) {
    return { kind: "opencode", installed: false, loggedIn: false, hint: INSTALL_HINT, models: [], caps: { ...OPENCODE_CAPS } };
  }
  const cliVersion = binary === undefined ? undefined : parseVersion((await exec(binary, ["--version"], 20_000)) ?? "");

  try {
    const { api, directory } = await probe();
    const health = await api.health().catch(() => undefined);
    const catalog = await api.providers();
    const agents = await api.agents({ directory }).catch(() => [] as WireAgent[]);
    const models = toModelInfo(catalog.providers, catalog.default, config.defaultModel);
    const version = health?.version ?? cliVersion;
    return {
      kind: "opencode",
      installed: true,
      loggedIn: models.length > 0,
      ...(version !== undefined ? { version } : {}),
      ...(models.length > 0 ? {} : { hint: LOGIN_HINT }),
      models,
      caps: capsFor(agents),
    };
  } catch (error) {
    env.log(`[opencode] status probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      kind: "opencode",
      installed: true,
      loggedIn: false,
      ...(cliVersion !== undefined ? { version: cliVersion } : {}),
      hint: LOGIN_HINT,
      models: [],
      caps: { ...OPENCODE_CAPS },
    };
  }
}
