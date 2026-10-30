import { connectedEnvIds, useEnvironments } from "../state/envStore.ts";

/**
 * Where environment-wide calls (`pr.list`, `usage.summary`) go: every connected
 * environment, primary first; a single `undefined` (the attached server) when the
 * client knows no environments (tests, the single-server build).
 */
export function callTargets(): (string | undefined)[] {
  const state = useEnvironments.getState();
  if (state.environments.length === 0) return [undefined];
  return connectedEnvIds(state);
}

/** More than one environment is connected: per-environment tags and sections apply. */
export function useMultiEnv(): boolean {
  return useEnvironments((s) => connectedEnvIds(s).length > 1);
}
