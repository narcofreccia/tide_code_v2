import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DriverCaps, DriverEnv, ModelInfo, ProviderStatus } from "@tide/contracts";
import { AcpConnection, rpcError } from "./jsonrpc.ts";
import { modelSelector } from "./models.ts";
import { modeSelector, planModeId } from "./permissions.ts";
import { authHint, clientInitialize, INITIALIZE_TIMEOUT_MS, isAuthRequired } from "./session.ts";
import { agentEnv } from "./spawn.ts";
import { ACP_ERROR, type AcpConfig, type AcpDeps, type AcpInitializeResult, type AcpNewSessionResult } from "./types.ts";

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
  /** set by an `auth_required` answer; cleared when a session opens */
  authHint?: string;
}

export function acpCaps(facts: AgentFacts): DriverCaps {
  const agent = facts.init?.agentCapabilities;
  return {
    planMode: facts.planMode ?? false,
    subagents: false,
    mcp: true,
    images: agent?.promptCapabilities?.image === true,
    resume: agent?.loadSession === true,
    contextUsage: false,
    openInTerminal: false,
    steer: false,
    fork: false,
    rollback: false,
    oneShot: false,
    effort: facts.effort ?? false,
    commands: true,
  };
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

export interface ProbeResult {
  status: ProviderStatus;
  facts: AgentFacts;
}

/** One probe. `facts` carries what earlier probes / sessions learned; the result merges into it. */
export async function probeStatus(config: AcpConfig, env: DriverEnv, deps: AcpDeps, label: string, facts: AgentFacts, version: string): Promise<ProbeResult> {
  const cwd = join(env.dataDir, "acp-probe");
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    // spawn reports a bad cwd itself
  }
  let child;
  try {
    child = deps.spawn(config.command, config.args ?? [], { cwd, env: agentEnv(config, env) });
  } catch (error) {
    return notInstalled(config, label, facts, error);
  }
  const conn = new AcpConnection(child, {
    label,
    log: (message) => env.log(message),
    onNotification: () => undefined,
    onRequest: (method) => {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
      throw rpcError(ACP_ERROR.methodNotFound, `Tide's status probe does not implement ${method}`);
    },
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
  try {
    const init = await conn.request<AcpInitializeResult>("initialize", clientInitialize(version), deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
    const next: AgentFacts = { ...facts, init };
    if (next.models === undefined) {
      try {
        const result = await conn.request<AcpNewSessionResult>("session/new", { cwd, mcpServers: [] }, PROBE_SESSION_TIMEOUT_MS);
        Object.assign(next, sessionFacts(result, config.defaultModel));
        delete next.authHint;
      } catch (error) {
        if (isAuthRequired(error)) next.authHint = authHint(label, init);
        else env.log(`[acp:${label}] probe session/new failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status: ProviderStatus = {
      kind: "acp",
      installed: true,
      loggedIn: next.authHint === undefined,
      ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}),
      ...(next.authHint ? { hint: next.authHint } : {}),
      models: next.models ?? [],
      caps: acpCaps(next),
    };
    return { status, facts: next };
  } catch (error) {
    if (isNotFound(error)) return notInstalled(config, label, facts, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: { kind: "acp", installed: true, loggedIn: false, hint: `${label} did not answer initialize: ${message}`, models: facts.models ?? [], caps: acpCaps(facts) },
      facts,
    };
  } finally {
    conn.close();
  }
}

function notInstalled(config: AcpConfig, label: string, facts: AgentFacts, error: unknown): ProbeResult {
  if (!isNotFound(error)) throw error;
  return { status: { kind: "acp", installed: false, loggedIn: false, hint: installHint(label, config.command), models: [], caps: acpCaps(facts) }, facts };
}
