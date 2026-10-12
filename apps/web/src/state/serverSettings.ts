import { create } from "zustand";
import type { ProviderKind, RuntimeMode, UserSettings, UserSettingsPatch } from "@tide/contracts";
import { errorText } from "../lib/dispatchOrToast.ts";
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

export function defaultUserSettings(): UserSettings {
  return { providerDefaults: {}, worktreeByDefault: true, decisions: { enabled: false, hasKey: false } };
}

export const useServerSettings = create<ServerSettingsState>(() => ({
  settings: defaultUserSettings(),
  loaded: false,
}));

/** Read on every connect; a server without the method keeps the defaults. */
export async function loadServerSettings(): Promise<void> {
  const settings = await call("settings.get", {});
  useServerSettings.setState({ settings, loaded: true });
}

/** The local view of a patch: what the server will answer, minus the key itself. */
function applyPatch(settings: UserSettings, patch: UserSettingsPatch): UserSettings {
  const decisions = patch.decisions;
  return {
    providerDefaults: patch.providerDefaults ?? settings.providerDefaults,
    worktreeByDefault: patch.worktreeByDefault ?? settings.worktreeByDefault,
    decisions: {
      enabled: decisions?.enabled ?? settings.decisions.enabled,
      hasKey: settings.decisions.hasKey,
    },
  };
}

/**
 * Optimistic: the change shows at once, the server's answer replaces it, and a
 * refusal puts the previous settings back with a toast.
 */
export async function patchServerSettings(patch: UserSettingsPatch): Promise<void> {
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

export function providerDefault(kind: ProviderKind): ProviderDefault {
  return useServerSettings.getState().settings.providerDefaults[kind] ?? {};
}

/** Merges into the harness's entry; the whole map is sent so the server never has to merge. */
export function setProviderDefault(kind: ProviderKind, patch: ProviderDefault): Promise<void> {
  const current = useServerSettings.getState().settings.providerDefaults;
  return patchServerSettings({ providerDefaults: { ...current, [kind]: { ...current[kind], ...patch } } });
}

export function setWorktreeByDefault(worktreeByDefault: boolean): Promise<void> {
  return patchServerSettings({ worktreeByDefault });
}

export function worktreeByDefault(): boolean {
  return useServerSettings.getState().settings.worktreeByDefault;
}

export function resetServerSettings(): void {
  useServerSettings.setState({ settings: defaultUserSettings(), loaded: false });
}
