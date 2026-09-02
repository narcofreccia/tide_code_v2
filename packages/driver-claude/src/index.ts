import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { ClaudeInstance } from "./instance.ts";
import type { ClaudeConfig, QueryFn } from "./types.ts";

export { ClaudeNormalizer, truncate } from "./normalize.ts";
export { isUnder, readOnlyLinkFor, readOnlyDenyMessage, targetPath } from "./links.ts";
export { ApprovalBroker, EXIT_PLAN_DENY_MESSAGE } from "./approvals.ts";
export { unifiedDiff } from "./diff.ts";
export { previewDiff } from "./edit-preview.ts";
export { shellQuote } from "./shell.ts";
export { CLAUDE_CAPS, LOGIN_COMMAND, LOGIN_HINT, parseVersion } from "./status.ts";
export type { ClaudeConfig, QueryFn, QueryLike } from "./types.ts";
export type { ClaudeMessage } from "./sdk-shapes.ts";

/**
 * Loads the real SDK lazily so tests (and a machine without the optional platform binary)
 * can use `config.queryImpl` without importing it at module load.
 */
async function sdkQuery(): Promise<QueryFn> {
  const module: unknown = await import("@anthropic-ai/claude-agent-sdk");
  const { query } = module as { query: (params: { prompt: unknown; options?: unknown }) => unknown };
  return ((params) => query(params as { prompt: unknown; options?: unknown })) as QueryFn;
}

export const claudeDriver: ProviderDriver<ClaudeConfig> = {
  kind: "claude",
  defaultConfig(): ClaudeConfig {
    return {};
  },
  async create(config: ClaudeConfig, env: DriverEnv): Promise<ProviderInstance> {
    const queryFn = config.queryImpl ?? (await sdkQuery());
    return new ClaudeInstance(config, env, queryFn);
  },
};

export default claudeDriver;
