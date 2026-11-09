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

interface SettingsEntry {
  settings: UserSettings;
  /** `settings.get` answered at least once on this connection */
  loaded: boolean;
}

/**
 * `settings` / `loaded` are always the PRIMARY environment's, so everything outside the
 * Settings page (composer, rail, shortcuts) keeps reading the primary. `byEnv` holds the other
 * connected environments' answers; `selectedId` is the machine the open Settings page edits
 * (SettingsView sets it only while a per-environment section is showing and clears it on leave).
 */
interface ServerSettingsState extends SettingsEntry {
  byEnv: Record<string, SettingsEntry>;
  selectedId: string | undefined;
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

export function defaultGitSettings(): UserSettings["git"] {
  return { mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true, pushThreadBranches: "never", syncBaseWithRemote: true, generateMessages: true };
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
    git: defaultGitSettings(),
    providerInstances: [],
    environment: { name: "" },
    glassBox: { limitsInStatusBar: true, readHarnessLogs: true },
    keybindings: {},
  };
}

export const useServerSettings = create<ServerSettingsState>(() => ({
  settings: defaultUserSettings(),
  loaded: false,
  byEnv: {},
  selectedId: undefined,
}));

const isPrimary = (envId: string | undefined): boolean => envId === undefined || envId === useEnvironments.getState().primaryId;

/** The environment edits go to: the selected one, else the primary (`undefined`). */
function targetEnv(envId: string | undefined, state: ServerSettingsState = useServerSettings.getState()): string | undefined {
  const id = envId ?? state.selectedId;
  return isPrimary(id) ? undefined : id;
}

function entryOf(state: ServerSettingsState, envId: string | undefined): SettingsEntry {
  const id = targetEnv(envId, state);
  return id === undefined ? { settings: state.settings, loaded: state.loaded } : (state.byEnv[id] ?? { settings: defaultUserSettings(), loaded: false });
}

function setEntry(envId: string | undefined, entry: SettingsEntry): void {
  const id = targetEnv(envId);
  if (id === undefined) useServerSettings.setState({ settings: entry.settings, loaded: entry.loaded });
  else useServerSettings.setState((s) => ({ byEnv: { ...s.byEnv, [id]: entry } }));
}

/** The selected environment's settings (the primary's when none is selected). */
export function useSelectedSettings<T>(selector: (entry: SettingsEntry) => T): T {
  return useServerSettings((s) => selector(entryOf(s, undefined)));
}

export function selectedSettings(): UserSettings {
  return entryOf(useServerSettings.getState(), undefined).settings;
}

export function selectSettingsEnv(envId: string | undefined): void {
  useServerSettings.setState({ selectedId: envId });
}

// The primary moved: swap mirrors, so no environment's answer is lost or shown for another.
// Environments that left (forgotten / disconnected) drop their entry and selection.
let knownPrimary = useEnvironments.getState().primaryId;
useEnvironments.subscribe((env) => {
  const state = useServerSettings.getState();
  let { settings, loaded, byEnv, selectedId } = state;
  if (env.primaryId !== knownPrimary) {
    const next = { ...byEnv };
    if (knownPrimary !== undefined && loaded) next[knownPrimary] = { settings, loaded };
    const incoming = env.primaryId === undefined ? undefined : next[env.primaryId];
    if (env.primaryId !== undefined) delete next[env.primaryId];
    settings = incoming?.settings ?? defaultUserSettings();
    loaded = incoming?.loaded ?? false;
    byEnv = next;
    knownPrimary = env.primaryId;
  }
  const alive = (id: string): boolean => id === env.primaryId || env.statuses[id]?.connection === "connected";
  const kept = Object.entries(byEnv).filter(([id]) => alive(id));
  if (kept.length !== Object.keys(byEnv).length) byEnv = Object.fromEntries(kept);
  if (selectedId !== undefined && !alive(selectedId)) selectedId = undefined;
  if (settings !== state.settings || loaded !== state.loaded || byEnv !== state.byEnv || selectedId !== state.selectedId) {
    useServerSettings.setState({ settings, loaded, byEnv, selectedId });
  }
});

/** Read on every connect, for every environment; a server without the method keeps the defaults. */
export async function loadServerSettings(envId?: string): Promise<void> {
  const settings = await (envId === undefined ? call("settings.get", {}) : call("settings.get", {}, { envId }));
  if (envId !== undefined && !isPrimary(envId) && useEnvironments.getState().statuses[envId]?.connection !== "connected") return;
  setEntry(envId === undefined ? undefined : envId, { settings, loaded: true });
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
    git: { ...settings.git, ...(patch.git ?? {}) },
    providerInstances: patch.providerInstances ?? settings.providerInstances,
    glassBox: { ...settings.glassBox, ...(patch.glassBox ?? {}) },
    keybindings: patch.keybindings !== undefined ? Object.fromEntries(Object.entries(patch.keybindings).filter(([, v]) => v !== "")) : settings.keybindings,
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
 * refusal puts the previous settings back with a toast. Goes to `envId`, else the
 * environment the open Settings page selected, else the primary.
 */
export async function patchServerSettings(patch: UserSettingsPatch, envId?: string): Promise<void> {
  const target = targetEnv(envId);
  const previous = entryOf(useServerSettings.getState(), target);
  setEntry(target, { settings: applyPatch(previous.settings, patch), loaded: previous.loaded });
  try {
    const settings = await (target === undefined ? call("settings.set", { patch }) : call("settings.set", { patch }, { envId: target }));
    setEntry(target, { settings, loaded: true });
  } catch (error) {
    setEntry(target, previous);
    showToast(`Saving settings failed: ${errorText(error)}`);
  }
}

/**
 * R8: defaults are keyed by instance id (the bundled default's id is its kind, so
 * older entries keep working). An extra account without its own entry inherits
 * its kind's defaults.
 */
export function providerDefault(id: string): ProviderDefault {
  const all = useServerSettings.getState().settings.providerDefaults; // the primary's: composers read it
  const own = all[id];
  if (own !== undefined) return own;
  const kind = id.split(":")[0] ?? id;
  return kind !== id ? (all[kind] ?? {}) : {};
}

/** Merges into the instance's entry; the whole map is sent so the server never has to merge. */
export function setProviderDefault(id: string, patch: ProviderDefault): Promise<void> {
  const current = selectedSettings().providerDefaults;
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

/** Blank clears the instructions. */
export function setTitleInstructions(text: string): Promise<void> {
  const trimmed = text.trim();
  return patchServerSettings({ titleInstructions: trimmed === "" ? null : trimmed });
}

export function setFollowUpDefault(followUpMode: UserSettings["followUpMode"]): Promise<void> {
  return patchServerSettings({ followUpMode });
}

export function setLimitPolicyDefault(limitPolicy: UserSettings["limitPolicy"]): Promise<void> {
  return patchServerSettings({ limitPolicy });
}

export function resetServerSettings(): void {
  useServerSettings.setState({ settings: defaultUserSettings(), loaded: false, byEnv: {}, selectedId: undefined });
}
