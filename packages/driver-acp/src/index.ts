import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { AcpInstance } from "./instance.ts";
import { nodeSpawn } from "./spawn.ts";
import type { AcpConfig, AcpDeps } from "./types.ts";

export { AcpInstance, CLIENT_VERSION } from "./instance.ts";
export { AcpSession, AcpAuthRequiredError, PROTOCOL_VERSION, INITIALIZE_TIMEOUT_MS, authHint, clientInitialize, isAuthRequired } from "./session.ts";
export { AcpNormalizer, ACP_SILENT_UPDATES, toSlashCommands, toolDiff, toolInput, toolName, toolOutput, truncate } from "./normalize.ts";
export { decisionOption, modePattern, modeSelector, planModeId, planPermission, targetModeId } from "./permissions.ts";
export type { ModeSelector, PermissionPlan } from "./permissions.ts";
export { effortSelector, modelSelector } from "./models.ts";
export { AcpSettings } from "./settings.ts";
export { FsPolicy } from "./fs.ts";
export { AcpConnection, RpcError, rpcError, splitLines } from "./jsonrpc.ts";
export { acpCaps, installHint, probeStatus, sessionFacts } from "./status.ts";
export type { AgentFacts } from "./status.ts";
export { agentEnv, nodeSpawn, toAcpMcpServers } from "./spawn.ts";
export { ACP_ERROR } from "./types.ts";
export type { AcpConfig, AcpDeps, ChildLike, SpawnLike, TimerLike } from "./types.ts";

export function createAcpInstance(config: AcpConfig, env: DriverEnv, deps: Partial<AcpDeps> = {}): ProviderInstance {
  return new AcpInstance(config, env, { ...deps, spawn: deps.spawn ?? nodeSpawn });
}

/**
 * Agent Client Protocol driver: one instance per configured agent. `defaultConfig()` is a
 * placeholder; the server always passes the resolved `{command, args}` of the instance.
 */
export const acpDriver: ProviderDriver<AcpConfig> = {
  kind: "acp",
  defaultConfig(): AcpConfig {
    return { command: "" };
  },
  async create(config: AcpConfig, env: DriverEnv): Promise<ProviderInstance> {
    if (!config.command) throw new Error("acp: no launch command configured for this agent");
    return createAcpInstance(config, env);
  },
};

export default acpDriver;
