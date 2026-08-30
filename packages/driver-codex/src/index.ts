import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { CodexInstance } from "./instance.ts";
import type { CodexConfig } from "./types.ts";

export { AppServer, mcpConfigArgs, mergedEnv } from "./app-server.ts";
export { ApprovalBroker, toCodexAnswers } from "./approvals.ts";
export { CodexInstance } from "./instance.ts";
export { JsonRpcConnection, JsonRpcError } from "./jsonrpc.ts";
export { collaborationModeFor, policyFor } from "./modes.ts";
export { CodexNormalizer } from "./normalize.ts";
export { CodexSession, turnInput } from "./session.ts";
export { shellQuote } from "./shell.ts";
export { CODEX_CAPS, INSTALL_HINT, LOGIN_HINT, parseVersion, toModelInfo } from "./status.ts";
export { toolShape, truncate } from "./items.ts";
export type { ChildLike, CodexConfig, CodexPolicy, SpawnFn } from "./types.ts";
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
