import type { DriverEnv, ModelInfo, ProviderStatus } from "@tide/contracts";
import { binaryVersion, detectBinary, majorOf, upgradeHint } from "./binary.ts";
import type { OpencodeApi, OpencodeConfig } from "./types.ts";
import type { WireAgent, WireModel } from "./wire.ts";

/** Verified against `opencode auth --help` (2.0.27: `auth login` — "connect an integration"). */
export const LOGIN_COMMAND = "opencode auth login";
export const LOGIN_HINT = "Run `opencode auth login` in a terminal";
export const INSTALL_HINT = "Install OpenCode 2: npm i -g @opencode/cli (https://opencode.ai)";

/**
 * Baseline capabilities; `planMode`/`subagents` are confirmed against `GET /api/agent`.
 * - `mcp`: `PUT /api/experimental/mcp/:name?location[directory]=` registers a server at
 *   runtime for one location, without writing the user's config (verified: no file appears).
 * - `images`: prompt `files[].uri` accepts `data:` URIs.
 * - `contextUsage`: `session.step.ended` carries per-step tokens, the catalog `limit.context`.
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

export function toModelInfo(models: WireModel[], defaultId: string | undefined): ModelInfo[] {
  return models
    .filter((model) => model.enabled !== false && model.status !== "deprecated")
    .map((model) => {
      const id = `${model.providerID}/${model.id}`;
      return { id, label: model.name || model.id, family: model.providerID, ...(id === defaultId ? { default: true } : {}) };
    });
}

/** Primary agents the user can pick, in the server's order (the configured default comes first). */
export function primaryAgents(agents: WireAgent[]): WireAgent[] {
  return agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden);
}

export function capsFor(agents: WireAgent[]): ProviderStatus["caps"] {
  if (agents.length === 0) return { ...OPENCODE_CAPS };
  return {
    ...OPENCODE_CAPS,
    planMode: agents.some((agent) => agent.id === "plan"),
    subagents: agents.some((agent) => agent.mode === "subagent" || agent.mode === "all"),
  };
}

export interface StatusProbe {
  api: OpencodeApi;
  directory: string;
  /** version reported by the server we are attached to */
  version?: string;
}

/**
 * Installed = a 2.x binary or a reachable 2.x server; a 1.x binary is reported installed but
 * unusable with the upgrade hint. Usable models come from the server's own catalog
 * (`GET /api/model`); an empty catalog means nothing is connected.
 */
export async function buildStatus(config: OpencodeConfig, env: DriverEnv, probe: () => Promise<StatusProbe>): Promise<ProviderStatus> {
  // `apiImpl` is the test seam: no real binary is probed when the server is scripted
  const binary = config.apiImpl ? undefined : await detectBinary(config);
  const cliVersion = binary === undefined ? undefined : await binaryVersion(binary);
  const v1 = (majorOf(cliVersion) ?? 2) < 2;
  try {
    const { api, directory, version } = await probe();
    const [models, fallback, agents] = await Promise.all([
      api.models({ directory }),
      api.defaultModel({ directory }).catch(() => undefined),
      api.agents({ directory }).catch(() => [] as WireAgent[]),
    ]);
    const defaultId = config.defaultModel ?? (fallback ? `${fallback.providerID}/${fallback.id}` : undefined);
    const infos = toModelInfo(models, defaultId);
    const shown = version ?? cliVersion;
    // attached to a 2.x server, but the CLI on PATH (used by "open in terminal") is 1.x
    const hint = infos.length === 0 ? LOGIN_HINT : v1 && cliVersion ? upgradeHint(cliVersion) : undefined;
    return {
      kind: "opencode",
      installed: true,
      loggedIn: infos.length > 0,
      ...(shown !== undefined ? { version: shown } : {}),
      ...(hint !== undefined ? { hint } : {}),
      ...(infos.length === 0 ? { loginCommand: LOGIN_COMMAND } : {}),
      models: infos,
      caps: capsFor(agents),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    env.log(`[opencode] status probe failed: ${message}`);
    if (binary === undefined && config.serverUrl === undefined) {
      return { kind: "opencode", installed: false, loggedIn: false, hint: INSTALL_HINT, models: [], caps: { ...OPENCODE_CAPS } };
    }
    return {
      kind: "opencode",
      installed: true,
      loggedIn: false,
      ...(cliVersion !== undefined ? { version: cliVersion } : {}),
      hint: v1 && cliVersion ? upgradeHint(cliVersion) : LOGIN_HINT,
      ...(v1 ? {} : { loginCommand: LOGIN_COMMAND }),
      models: [],
      caps: { ...OPENCODE_CAPS },
    };
  }
}
