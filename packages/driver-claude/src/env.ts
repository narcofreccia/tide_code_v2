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

/** The `CLAUDE_CONFIG_DIR` the spawned CLI sees (same precedence as the session's env), if any. */
export function claudeConfigDir(config: ClaudeConfig, env: DriverEnv, sessionEnv: Record<string, string> = {}): string | undefined {
  return sessionEnv["CLAUDE_CONFIG_DIR"] ?? instanceEnv(config, env)["CLAUDE_CONFIG_DIR"] ?? process.env["CLAUDE_CONFIG_DIR"];
}
