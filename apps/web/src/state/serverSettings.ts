import { create } from "zustand";
import type { ProviderInstanceConfig, RuntimeMode, UserSettings, UserSettingsPatch } from "@tide/contracts";
import { errorText } from "../lib/dispatchOrToast.ts";
import { useEnvironments } from "./envStore.ts";
import { call } from "./model.ts";
import { showToast } from "./toast.ts";

/**
 * Settings that every client and every server-created thread (delegates, experts,
 * plan.implement) must agree on live on the server (`settings.get|set`). Theme,
 * density and layout stay local to this browser (`state/settings.ts`, `state/ui.ts`).
 */
export interface ProviderDefault {
  /** empty string means "let the harness choose" */
  model?: string;
  mode?: RuntimeMode;
}

interface ServerSettingsState {
  settings: UserSettings;
  /** `settings.get` answered at least once on this connection */
  loaded: boolean;
}

/** R6: the decision layer's defaults; the server fills the informational fields from its client constants. */
export function defaultDecisionsSettings(): UserSettings["decisions"] {
  return {
    enabled: false,
    hasKey: false,
    model: "jev-latest",
    endpoint: "https://api.typesafe.ai",
    usdPerMillionInput: 0.042,
    contextTokens: 28_000,
    grayZone: { low: 0.6, high: 0.85 },
    sites: { handoff: true, experts: true, delegates: true, approvals: true, stuck: true },
    expertsAutoAdvance: false,
  };
}

export function defaultInboxSettings(): UserSettings["inbox"] {
  return { autoSettleAfterDays: 3, autoSettleOnMerge: true, workingSection: false };
}

export function defaultUserSettings(): UserSettings {
  return {
    providerDefaults: {},
    worktreeByDefault: true,
    decisions: defaultDecisionsSettings(),
    continueAfterRestart: false,
    followUpMode: "steer",
    limitPolicy: "manual",
    teams: [],
    inbox: defaultInboxSettings(),
    providerInstances: [],
    environment: { name: "" },
  };
}

export const useServerSettings = create<ServerSettingsState>(() => ({
  settings: defaultUserSettings(),
  loaded: false,
}));

/**
 * Read on every connect; a server without the method keeps the defaults. R9: the settings
 * shown are the primary environment's; an answer from an environment that is no longer
 * the primary is dropped.
 */
export async function loadServerSettings(envId?: string): Promise<void> {
  const settings = await (envId === undefined ? call("settings.get", {}) : call("settings.get", {}, { envId }));
  if (envId !== undefined && envId !== useEnvironments.getState().primaryId) return;
  useServerSettings.setState({ settings, loaded: true });
}

function clearFallback(d: UserSettings["decisions"], clear: boolean): UserSettings["decisions"] {
  if (!clear) return d;
  const { fallback: _fallback, ...rest } = d;
  return rest;
}

/** The local view of a patch: what the server will answer, minus the key itself. */
function applyPatch(settings: UserSettings, patch: UserSettingsPatch): UserSettings {
  const decisions = patch.decisions;
  return {
    providerDefaults: patch.providerDefaults ?? settings.providerDefaults,
    worktreeByDefault: patch.worktreeByDefault ?? settings.worktreeByDefault,
    decisions: clearFallback({
      ...settings.decisions,
      enabled: decisions?.enabled ?? settings.decisions.enabled,
      hasKey: settings.decisions.hasKey,
      ...(decisions?.fallback === undefined ? {} : decisions.fallback === null ? {} : { fallback: decisions.fallback }),
      grayZone: decisions?.grayZone ?? settings.decisions.grayZone,
      sites: { ...settings.decisions.sites, ...(decisions?.sites ?? {}) },
      expertsAutoAdvance: decisions?.expertsAutoAdvance ?? settings.decisions.expertsAutoAdvance,
    }, decisions?.fallback === null),
    continueAfterRestart: patch.continueAfterRestart ?? settings.continueAfterRestart,
    followUpMode: patch.followUpMode ?? settings.followUpMode,
    limitPolicy: patch.limitPolicy ?? settings.limitPolicy,
    teams: patch.teams ?? settings.teams,
    inbox: { ...settings.inbox, ...(patch.inbox ?? {}) },
    providerInstances: patch.providerInstances ?? settings.providerInstances,
    environment: {
      name: patch.environment?.name ?? settings.environment.name,
      ...(patch.environment?.sshHost === null ? {} : patch.environment?.sshHost !== undefined ? { sshHost: patch.environment.sshHost } : settings.environment.sshHost !== undefined ? { sshHost: settings.environment.sshHost } : {}),
    },
    ...(patch.relay === null ? {} : patch.relay !== undefined ? { relay: { url: patch.relay.url, hasKey: patch.relay.key !== undefined || settings.relay?.hasKey === true } } : settings.relay !== undefined ? { relay: settings.relay } : {}),
    ...(patch.textModel === null ? {} : patch.textModel !== undefined ? { textModel: patch.textModel } : settings.textModel !== undefined ? { textModel: settings.textModel } : {}),
  };
}

/**
 * Optimistic: the change shows at once, the server's answer replaces it, and a
 * refusal puts the previous settings back with a toast. R9: with an `envId` other than
 * the primary the patch goes to that environment only and the shown settings stay put.
 */
export async function patchServerSettings(patch: UserSettingsPatch, envId?: string): Promise<void> {
  if (envId !== undefined && envId !== useEnvironments.getState().primaryId) {
    try {
      await call("settings.set", { patch }, { envId });
    } catch (error) {
      showToast(`Saving settings failed: ${errorText(error)}`);
    }
    return;
  }
  const previous = useServerSettings.getState().settings;
  useServerSettings.setState({ settings: applyPatch(previous, patch) });
  try {
    const settings = await call("settings.set", { patch });
    useServerSettings.setState({ settings, loaded: true });
  } catch (error) {
    useServerSettings.setState({ settings: previous });
    showToast(`Saving settings failed: ${errorText(error)}`);
  }
}

/**
 * R8: defaults are keyed by instance id (the bundled default's id is its kind, so
 * older entries keep working). An extra account without its own entry inherits
 * its kind's defaults.
 */
export function providerDefault(id: string): ProviderDefault {
  const all = useServerSettings.getState().settings.providerDefaults;
  const own = all[id];
  if (own !== undefined) return own;
  const kind = id.split(":")[0] ?? id;
  return kind !== id ? (all[kind] ?? {}) : {};
}

/** Merges into the instance's entry; the whole map is sent so the server never has to merge. */
export function setProviderDefault(id: string, patch: ProviderDefault): Promise<void> {
  const current = useServerSettings.getState().settings.providerDefaults;
  return patchServerSettings({ providerDefaults: { ...current, [id]: { ...current[id], ...patch } } });
}

/** R8: the user's extra accounts / ACP agents; the list is replaced wholesale. */
export function setProviderInstances(providerInstances: ProviderInstanceConfig[]): Promise<void> {
  return patchServerSettings({ providerInstances });
}

export function setWorktreeByDefault(worktreeByDefault: boolean): Promise<void> {
  return patchServerSettings({ worktreeByDefault });
}

export function worktreeByDefault(): boolean {
  return useServerSettings.getState().settings.worktreeByDefault;
}

export function setContinueAfterRestart(continueAfterRestart: boolean): Promise<void> {
  return patchServerSettings({ continueAfterRestart });
}

export function setFollowUpDefault(followUpMode: UserSettings["followUpMode"]): Promise<void> {
  return patchServerSettings({ followUpMode });
}

export function setLimitPolicyDefault(limitPolicy: UserSettings["limitPolicy"]): Promise<void> {
  return patchServerSettings({ limitPolicy });
}

export function resetServerSettings(): void {
  useServerSettings.setState({ settings: defaultUserSettings(), loaded: false });
}
