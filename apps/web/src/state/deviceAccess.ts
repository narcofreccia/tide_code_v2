import { useEnvironments } from "./envStore.ts";
import { useModel } from "./model.ts";
import { showToast } from "./toast.ts";

/**
 * R19: a paired device has an access level on each machine. `limited` (the default for a new
 * device) reads, chats, answers approvals, reviews and merges; `full` adds terminals, file
 * writes, settings, projects, the run stack and full-access runtime mode. The owner is never
 * restricted: the server leaves `ServerInfo.access` out for it (and an older server leaves it
 * out for everyone), so only an explicit `"limited"` disables anything here.
 *
 * Controls the server would refuse are disabled with this reason as their tooltip / hint,
 * the same way R18 disabled them for an offline machine (`state/threadEnv.ts`).
 */

/** The copy shown on every control a limited device cannot use. */
export function deviceLimitReason(machine: string): string {
  return `This device has limited access. Turn on Full access for it on ${machine}.`;
}

// a leaf read of the store (not `environmentName`), so state modules can import this without a cycle
function machineName(id: string | undefined): string {
  const state = useEnvironments.getState();
  const env = id === undefined ? undefined : state.environments.find((e) => e.id === id);
  return env?.name || (id === undefined ? undefined : state.statuses[id]?.info?.name) || "that machine";
}

function reasonFor(id: string | undefined, limited: boolean): string | undefined {
  return limited ? deviceLimitReason(machineName(id)) : undefined;
}

/** Why this device cannot change things on an environment (undefined: the primary); undefined when it can. */
export function useDeviceLimit(envId: string | undefined): string | undefined {
  const id = useEnvironments((s) => envId ?? s.primaryId);
  const limited = useEnvironments((s) => id !== undefined && s.statuses[id]?.info?.access === "limited");
  return reasonFor(id, limited);
}

/** The same for the machine that owns a thread. */
export function useThreadDeviceLimit(threadId: string | undefined): string | undefined {
  const owner = useModel((s) => (threadId === undefined ? undefined : s.ownership.threads[threadId]));
  return useDeviceLimit(owner);
}

/** The same for the machine that owns a project. */
export function useProjectDeviceLimit(projectId: string | undefined): string | undefined {
  const owner = useModel((s) => (projectId === undefined ? undefined : s.ownership.projects[projectId]));
  return useDeviceLimit(owner);
}

/** Non-hook read for actions (menus, shortcuts, palette) that run outside a render. */
export function deviceLimitOf(envId: string | undefined): string | undefined {
  const state = useEnvironments.getState();
  const id = envId ?? state.primaryId;
  return reasonFor(id, id !== undefined && state.statuses[id]?.info?.access === "limited");
}

export function threadDeviceLimitOf(threadId: string): string | undefined {
  return deviceLimitOf(useModel.getState().ownership.threads[threadId]);
}

export function projectDeviceLimitOf(projectId: string): string | undefined {
  return deviceLimitOf(useModel.getState().ownership.projects[projectId]);
}

/** Short form for an inline menu hint, where the full sentence does not fit. */
export const LIMITED_HINT = "this device has limited access";

/** For an action outside a render: shows the reason and answers true when it applies. */
export function refusedForLimit(limit: string | undefined): limit is string {
  if (limit !== undefined) showToast(limit);
  return limit !== undefined;
}

/**
 * A runtime-mode picker's options with Full access disabled (and the reason as its tooltip)
 * when this device is limited on that machine: the server refuses that mode for it.
 */
export function limitModeOptions<T extends { value: string; disabled?: boolean; title?: string }>(options: T[], limit: string | undefined): T[] {
  if (limit === undefined) return options;
  return options.map((option) => (option.value === "full-access" ? { ...option, disabled: true, title: limit } : option));
}

/** Why a draft cannot start with `mode` here (Full access on a limited device); undefined when it can. */
export function modeBlocked(mode: string | undefined, limit: string | undefined): string | undefined {
  return mode === "full-access" ? limit : undefined;
}
