import { useEnvironments } from "./envStore.ts";
import { environmentName } from "./environments.ts";
import { useModel } from "./model.ts";

/**
 * Whether the machine that owns a thread can take a send right now.
 *
 * - `online`: its connection is up.
 * - `primary`: the thread runs on the primary machine (or there is only one server), so a
 *   drop is the app-wide "reconnecting" state, not "another machine is offline".
 * - `machine`: the owner's display name, for "<machine> is offline".
 *
 * Commands are not queued across a drop (EnvironmentConnection rejects calls while offline
 * and fails in-flight ones on close), so callers disable sending while `!online`.
 */
export interface ThreadEnvStatus {
  online: boolean;
  primary: boolean;
  machine: string;
}

/** The status of one environment; `envId` undefined means the primary. */
export function useEnvStatus(envId: string | undefined): ThreadEnvStatus {
  const primaryId = useEnvironments((s) => s.primaryId);
  const managed = useEnvironments((s) => s.environments.length > 0);
  const id = envId ?? primaryId;
  const connection = useEnvironments((s) => (id === undefined ? undefined : s.statuses[id]?.connection));
  const status = useModel((s) => s.status);
  // single-server mode (tests, `attachModelStore`): the one connection is the primary
  if (!managed || id === undefined) return { online: status === "open", primary: true, machine: "the server" };
  return { online: connection === "connected", primary: id === primaryId, machine: environmentName(id) };
}

export function useThreadEnvStatus(threadId: string | undefined): ThreadEnvStatus {
  const owner = useModel((s) => (threadId === undefined ? undefined : s.ownership.threads[threadId]));
  return useEnvStatus(owner);
}

/** Composer / card copy for a machine that cannot take a send. */
export function offlineReason(env: ThreadEnvStatus): string {
  return env.primary ? "Not connected to the server" : `${env.machine} is offline`;
}

/** Why a thread's actions cannot reach its machine right now; undefined while connected. */
export function useOfflineReason(threadId: string | undefined): string | undefined {
  const env = useThreadEnvStatus(threadId);
  return env.online ? undefined : offlineReason(env);
}

/** The same for an environment by id (undefined: the primary). */
export function useEnvOfflineReason(envId: string | undefined): string | undefined {
  const env = useEnvStatus(envId);
  return env.online ? undefined : offlineReason(env);
}
