import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DriverCaps, DriverEnv, ModelInfo, ProviderStatus, SlashCommandInfo } from "@tide/contracts";
import { AcpConnection, rpcError } from "./jsonrpc.ts";
import { modelSelector } from "./models.ts";
import { toSlashCommands } from "./normalize.ts";
import { modeSelector, planModeId } from "./permissions.ts";
import { authHint, clientInitialize, INITIALIZE_TIMEOUT_MS, isAuthRequired } from "./session.ts";
import { agentEnv } from "./spawn.ts";
import { ACP_ERROR, GENERIC_FLAVOR, type AcpConfig, type AcpFlavor, type AcpDeps, type AcpInitializeResult, type AcpNewSessionResult } from "./types.ts";

/**
 * `status()` for an ACP agent: spawn it, `initialize`, read capabilities / agentInfo /
 * authMethods, kill it. Models, effort levels and plan mode live on sessions in ACP, so the
 * first probe also opens one throwaway session in `<dataDir>/acp-probe` (never in a user repo);
 * live sessions refresh what it learned. An `auth_required` answer there is how a logged-out
 * agent shows up: status reports `loggedIn: false` with the agent's own login hint.
 */

export const PROBE_SESSION_TIMEOUT_MS = 30_000;

/** What the agent told us about itself; merged from probes and live sessions. */
export interface AgentFacts {
  init?: AcpInitializeResult;
  models?: ModelInfo[];
  planMode?: boolean;
  effort?: boolean;
  /** the agent sent a `usage_update` with `used`/`size` (probe or live session): it reports context usage */
  contextUsage?: boolean;
  /** set by an `auth_required` answer; cleared when a session opens */
  authHint?: string;
}

export function acpCaps(facts: AgentFacts, flavor: AcpFlavor = GENERIC_FLAVOR): DriverCaps {
  const agent = facts.init?.agentCapabilities;
  return {
    planMode: facts.planMode ?? false,
    subagents: false,
    mcp: true,
    images: agent?.promptCapabilities?.image === true,
    resume: agent?.loadSession === true,
    // only known once the agent sends a `usage_update` carrying `used`/`size` (unstable ACP field)
    contextUsage: facts.contextUsage === true,
    openInTerminal: flavor.terminalCommand !== undefined,
    steer: false,
    fork: false,
    rollback: false,
    oneShot: false,
    effort: facts.effort ?? false,
    commands: true,
  };
}

/** A `usage_update` that carries the context window figures (what the normalizer turns into `contextUsage`). */
export function reportsContext(update: Record<string, unknown>): boolean {
  return typeof update["used"] === "number" && typeof update["size"] === "number" && update["size"] > 0;
}

export function installHint(label: string, command: string): string {
  return `${label} could not be started (\`${command}\` not found): install it or pick another agent from the registry`;
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

export function sessionFacts(result: Pick<AcpNewSessionResult, "modes" | "configOptions" | "models">, defaultModel?: string): Pick<AgentFacts, "models" | "planMode" | "effort"> {
  const models = modelSelector(result.configOptions, result.models, defaultModel)?.models ?? [];
  return {
    models,
    planMode: planModeId(modeSelector(result.modes, result.configOptions)) !== undefined,
    effort: (result.configOptions ?? []).some((option) => option.category === "thought_level"),
  };
}

/** `major.minor` of a version string, undefined when it does not start with two numbers. */
function majorMinor(version: string | undefined): [number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** True when the agent reported a version below the flavor's floor; an unknown version passes. */
export function belowMinVersion(flavor: AcpFlavor, version: string | undefined): boolean {
  const floor = flavor.minVersion;
  const found = majorMinor(version);
  if (!floor || !found) return false;
  return found[0] < floor.major || (found[0] === floor.major && found[1] < floor.minor);
}

export interface ProbeOptions {
  config: AcpConfig;
  env: DriverEnv;
  deps: AcpDeps;
  label: string;
  /** what earlier probes / sessions learned; the result merges into it */
  facts: AgentFacts;
  /** Tide's version, sent as `clientInfo.version` */
  version: string;
  flavor?: AcpFlavor;
  /** an `available_commands_update` the throwaway session sends before the probe closes */
  onCommands?: (commands: SlashCommandInfo[]) => void;
}

export interface ProbeResult {
  status: ProviderStatus;
  facts: AgentFacts;
}

/** One probe. */
export async function probeStatus(options: ProbeOptions): Promise<ProbeResult> {
  const { config, env, deps, label, facts, version, onCommands } = options;
  const flavor = options.flavor ?? GENERIC_FLAVOR;
  const cwd = join(env.dataDir, "acp-probe");
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    // spawn reports a bad cwd itself
  }
  let child;
  let sawContextUsage = false;
  try {
    child = deps.spawn(config.command, config.args ?? [], { cwd, env: agentEnv(config, env) });
  } catch (error) {
    return notInstalled(config, label, facts, flavor, error);
  }
  const conn = new AcpConnection(child, {
    label,
    log: (message) => env.log(message),
    onNotification: (method, params) => {
      const update = method === "session/update" ? (params as { update?: { sessionUpdate?: unknown; availableCommands?: unknown } } | null)?.update : undefined;
      if (update?.sessionUpdate === "available_commands_update") onCommands?.(toSlashCommands(update.availableCommands));
      if (update?.sessionUpdate === "usage_update" && reportsContext(update)) sawContextUsage = true;
    },
    onRequest: (method) => {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
      throw rpcError(ACP_ERROR.methodNotFound, `Tide's status probe does not implement ${method}`);
    },
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
  try {
    const init = await conn.request<AcpInitializeResult>("initialize", clientInitialize(version, config.quirks), deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
    const next: AgentFacts = { ...facts, init };
    const agentVersion = init.agentInfo?.version ?? undefined;
    if (flavor.minVersion && belowMinVersion(flavor, agentVersion)) {
      return {
        status: { kind: flavor.kind, installed: true, loggedIn: false, ...(agentVersion ? { version: agentVersion } : {}), hint: flavor.minVersion.hint, models: next.models ?? [], caps: acpCaps(next, flavor) },
        facts: next,
      };
    }
    if (next.models === undefined) {
      try {
        const result = await conn.request<AcpNewSessionResult>("session/new", { cwd, mcpServers: [] }, PROBE_SESSION_TIMEOUT_MS);
        Object.assign(next, sessionFacts(result, config.defaultModel));
        delete next.authHint;
        if (sawContextUsage) next.contextUsage = true;
      } catch (error) {
        if (isAuthRequired(error)) next.authHint = authHint(label, init);
        else env.log(`[acp:${label}] probe session/new failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status: ProviderStatus = {
      kind: flavor.kind,
      installed: true,
      loggedIn: next.authHint === undefined,
      ...(agentVersion ? { version: agentVersion } : {}),
      ...(next.authHint ? { hint: next.authHint } : {}),
      ...(next.authHint && flavor.loginCommand ? { loginCommand: flavor.loginCommand } : {}),
      models: next.models ?? [],
      caps: acpCaps(next, flavor),
    };
    return { status, facts: next };
  } catch (error) {
    if (isNotFound(error)) return notInstalled(config, label, facts, flavor, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: { kind: flavor.kind, installed: true, loggedIn: false, hint: `${label} did not answer initialize: ${message}`, models: facts.models ?? [], caps: acpCaps(facts, flavor) },
      facts,
    };
  } finally {
    conn.close();
  }
}

function notInstalled(config: AcpConfig, label: string, facts: AgentFacts, flavor: AcpFlavor, error: unknown): ProbeResult {
  if (!isNotFound(error)) throw error;
  const hint = (flavor.notInstalledHint ?? installHint)(label, config.command);
  return { status: { kind: flavor.kind, installed: false, loggedIn: false, hint, models: [], caps: acpCaps(facts, flavor) }, facts };
}
