import { spawn } from "node:child_process";
import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { PiInstance } from "./instance.ts";
import type { ChildLike, FetchLike, PiConfig, PiDeps, SpawnLike } from "./types.ts";

export { PI_SILENT_EVENTS, PiNormalizer, truncate } from "./normalize.ts";
export { PI_QUESTION_ID, PiApprovalBroker, dialogResponse } from "./approvals.ts";
export { PiRpc, readJsonl, splitJsonl } from "./rpc.ts";
export { PiSession, promptDisposition } from "./session.ts";
export { buildSpawn, splitModelId } from "./spawn.ts";
export { displayToolName } from "./tool-names.ts";
export { PiInstance } from "./instance.ts";
export { resolveBridgePath } from "./bridge-path.ts";
export { unifiedDiff } from "./diff.ts";
export { isDiffTool, previewDiff } from "./edit-preview.ts";
export { shellQuote } from "./shell.ts";
export { INSTALL_HINT, LOGIN_COMMAND, LOGIN_HINT, PI_CAPS, TESTED_PI_VERSION, detectBinary, detectLogin, mergeModels, parseVersion, probeVersion, workspaceBinary } from "./status.ts";
export type { DetectedBinary, VersionProbe } from "./status.ts";
export {
  LMSTUDIO_BASE_URL,
  LMSTUDIO_MODELS_URL,
  OLLAMA_BASE_URL,
  OLLAMA_TAGS_URL,
  detectLmStudio,
  detectLocalModels,
  detectOllama,
  ensureLocalProvider,
  modelsJsonPath,
  parseLocalModelId,
  readModelsJson,
} from "./local-models.ts";
export type { ChildLike, FetchLike, PiConfig, PiDeps, SpawnLike, TimerLike } from "./types.ts";

/** node's `spawn` narrowed to the slice the driver uses (declared boundary, CLAUDE.md §5). */
const nodeSpawn: SpawnLike = (command, args, options) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike;
const nodeFetch: FetchLike = (url, init) => fetch(url, init);

export function createPiInstance(config: PiConfig, env: DriverEnv, deps: Partial<PiDeps> = {}): ProviderInstance {
  return new PiInstance(config, env, {
    spawn: deps.spawn ?? nodeSpawn,
    fetch: deps.fetch ?? nodeFetch,
    ...(deps.bridgePath ? { bridgePath: deps.bridgePath } : {}),
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
}

export const piDriver: ProviderDriver<PiConfig> = {
  kind: "pi",
  defaultConfig(): PiConfig {
    return {};
  },
  async create(config: PiConfig, env: DriverEnv): Promise<ProviderInstance> {
    return createPiInstance(config, env);
  },
};

export default piDriver;
