import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { CodexInstance } from "./instance.ts";
import type { CodexConfig } from "./types.ts";

export { AppServer, CODEX_THREAD_CONFIG, INITIALIZE_TIMEOUT_MS, KILL_GRACE_MS, TIDE_DIRECT_MCP_SERVER, TIDE_DIRECT_ONLY_TOOLS, mcpEnvAndArgs, mergedEnv } from "./app-server.ts";
export { ApprovalBroker, toCodexAnswers } from "./approvals.ts";
export { buildCodexAdditionalContext, CODEX_ADDITIONAL_CONTEXT_MAX_BYTES, splitForCodexContext, toInjectItems } from "./instructions.ts";
export type { AdditionalContextEntry, AdditionalContextMap, CodexRuntimeInfo } from "./instructions.ts";
export { CodexInstance } from "./instance.ts";
export { JsonRpcConnection, JsonRpcError } from "./jsonrpc.ts";
export { collaborationModeFor, policyFor, writableRoots } from "./modes.ts";
export { parseSandboxNetworkAccess, parseUserSandboxConfig, readSandboxNetworkAccess, readUserSandboxConfig } from "./config-toml.ts";
export type { UserSandboxConfig } from "./config-toml.ts";
export { CodexNormalizer } from "./normalize.ts";
export { CodexSession, turnInput } from "./session.ts";
export { shellQuote } from "./shell.ts";
export { CODEX_CAPS, INSTALL_HINT, LOGIN_COMMAND, LOGIN_HINT, parseVersion, toModelInfo } from "./status.ts";
export { toolShape, truncate } from "./items.ts";
export type { ChildLike, CodexConfig, CodexPolicy, SpawnFn, TimerLike } from "./types.ts";
export type { RequestId } from "./jsonrpc.ts";

export const codexDriver: ProviderDriver<CodexConfig> = {
  kind: "codex",
  defaultConfig(): CodexConfig {
    return {};
  },
  async create(config: CodexConfig, env: DriverEnv): Promise<ProviderInstance> {
    return new CodexInstance(config, env);
  },
};

export default codexDriver;
