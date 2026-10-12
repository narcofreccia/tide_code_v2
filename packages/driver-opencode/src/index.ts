import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { OpencodeInstance } from "./instance.ts";
import type { OpencodeConfig } from "./types.ts";

export { OpencodeNormalizer, truncate, formQuestions } from "./normalize.ts";
export { permissionRuleset, linkRules, sessionRuleset, replyFor, userRules, narrowedUserRules, evaluate, wildcardMatch } from "./permissions.ts";
export { OpencodeServer, discoverService, serviceFile } from "./server.ts";
export { EventHub } from "./hub.ts";
export { OpencodeSession } from "./session.ts";
export { chooseAgents, mcpServerName, OpencodeInstance, parseModelId } from "./instance.ts";
export { HttpOpencodeApi, parseSse } from "./client.ts";
export { OPENCODE_CAPS, LOGIN_COMMAND, LOGIN_HINT, INSTALL_HINT, buildStatus, capsFor, toModelInfo } from "./status.ts";
export { assertV2, detectBinary, parseVersion, upgradeHint } from "./binary.ts";
export { shellQuote } from "./shell.ts";
export type { OpencodeConfig, OpencodeApi, ModelRef, PromptFile } from "./types.ts";
export type { OpencodeEvent, PermissionRule, PermissionReply } from "./wire.ts";

export const opencodeDriver: ProviderDriver<OpencodeConfig> = {
  kind: "opencode",
  defaultConfig(): OpencodeConfig {
    return {};
  },
  async create(config: OpencodeConfig, env: DriverEnv): Promise<ProviderInstance> {
    return new OpencodeInstance(config, env);
  },
};

export default opencodeDriver;
