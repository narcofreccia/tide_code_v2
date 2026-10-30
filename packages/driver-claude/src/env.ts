import type { DriverEnv } from "@tide/contracts";
import type { ClaudeConfig } from "./types.ts";

/** Config env, then the instance's env, then its `home` as CLAUDE_CONFIG_DIR (a second Claude account). */
export function instanceEnv(config: ClaudeConfig, env: DriverEnv): Record<string, string> {
  const instance = env.instance;
  return {
    ...config.env,
    ...instance?.env,
    ...(instance?.home ? { CLAUDE_CONFIG_DIR: instance.home } : {}),
  };
}
