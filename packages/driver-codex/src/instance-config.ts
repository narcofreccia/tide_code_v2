import type { DriverEnv } from "@tide/contracts";
import type { CodexConfig } from "./types.ts";

/**
 * R8: folds the instance a driver was created for into its config — `instance.env` over
 * `config.env`, and `instance.home` as `CODEX_HOME` (child env) and `codexHome` (the
 * config.toml reader), so a second Codex account is a different home directory.
 */
export function withInstance(config: CodexConfig, env: DriverEnv): CodexConfig {
  const instance = env.instance;
  if (!instance) return config;
  const merged: Record<string, string> = { ...config.env, ...instance.env, ...(instance.home ? { CODEX_HOME: instance.home } : {}) };
  return { ...config, env: merged, ...(instance.home ? { codexHome: instance.home } : {}) };
}
