import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { OpencodeInstance } from "./instance.ts";
import type { OpencodeConfig } from "./types.ts";

export { OpencodeNormalizer, truncate } from "./normalize.ts";
export { permissionRuleset, linkRules, sessionRuleset, replyFor } from "./permissions.ts";
export { OpencodeServer } from "./server.ts";
export { OpencodeSession } from "./session.ts";
export { OpencodeInstance, parseModelId } from "./instance.ts";
export { SdkOpencodeApi } from "./client.ts";
export { OPENCODE_CAPS, LOGIN_HINT, INSTALL_HINT, buildStatus, capsFor, toModelInfo } from "./status.ts";
export { detectBinary, parseVersion } from "./binary.ts";
export { shellQuote } from "./shell.ts";
export type { OpencodeConfig, OpencodeApi, ModelRef, PromptPart } from "./types.ts";
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
