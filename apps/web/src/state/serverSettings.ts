import { create } from "zustand";
import type { CodexMultiAgentMode, ProviderInstanceConfig, RuntimeMode, UserSettings, UserSettingsPatch } from "@tide/contracts";
import { errorText } from "../lib/dispatchOrToast.ts";
import { deviceLimitOf } from "./deviceAccess.ts";
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
  /** Codex only: proactive lets Codex spawn sub-agents without an explicit request */
  multiAgentMode?: CodexMultiAgentMode;
}

interface SettingsEntry {
  settings: UserSettings;
  /** `settings.get` answered at least once on this connection */
  loaded: boolean;
  /** the last `settings.get` failed and nothing has loaded yet: Settings shows it with Retry */
  error?: string | undefined;
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
  return { autoSettleAfterDays: 3, autoSettleOnMerge: true, archiveOnAutoSettle: false, workingSection: false };
}

export function defaultGitSettings(): UserSettings["git"] {
  return { mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true, pushThreadBranches: "never", syncBaseWithRemote: true, pushBaseAfterMerge: false, generateMessages: true };
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
  return id === undefined ? { settings: state.settings, loaded: state.loaded, error: state.error } : (state.byEnv[id] ?? { settings: defaultUserSettings(), loaded: false });
}

function setEntry(envId: string | undefined, entry: SettingsEntry): void {
  const id = targetEnv(envId);
  if (id === undefined) useServerSettings.setState({ settings: entry.settings, loaded: entry.loaded, error: entry.error });
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
  let { settings, loaded, error, byEnv, selectedId } = state;
  if (env.primaryId !== knownPrimary) {
    const next = { ...byEnv };
    if (knownPrimary !== undefined && loaded) next[knownPrimary] = { settings, loaded };
    const incoming = env.primaryId === undefined ? undefined : next[env.primaryId];
    if (env.primaryId !== undefined) delete next[env.primaryId];
    settings = incoming?.settings ?? defaultUserSettings();
    loaded = incoming?.loaded ?? false;
    error = incoming?.error;
    byEnv = next;
    knownPrimary = env.primaryId;
  }
  const alive = (id: string): boolean => id === env.primaryId || env.statuses[id]?.connection === "connected";
  const kept = Object.entries(byEnv).filter(([id]) => alive(id));
  if (kept.length !== Object.keys(byEnv).length) byEnv = Object.fromEntries(kept);
  if (selectedId !== undefined && !alive(selectedId)) selectedId = undefined;
  if (settings !== state.settings || loaded !== state.loaded || error !== state.error || byEnv !== state.byEnv || selectedId !== state.selectedId) {
    useServerSettings.setState({ settings, loaded, error, byEnv, selectedId });
  }
});

/** Read on every connect, for every environment; a server without the method keeps the defaults. */
export async function loadServerSettings(envId?: string): Promise<void> {
  const gone = (): boolean => envId !== undefined && !isPrimary(envId) && useEnvironments.getState().statuses[envId]?.connection !== "connected";
  let settings: UserSettings;
  try {
    settings = await (envId === undefined ? call("settings.get", {}) : call("settings.get", {}, { envId }));
  } catch (error) {
    const entry = entryOf(useServerSettings.getState(), envId);
    // an earlier answer stays good; only a page that never loaded shows the failure
    if (!gone() && !entry.loaded) setEntry(envId, { ...entry, error: errorText(error) });
    throw error;
  }
  if (gone()) return;
  setEntry(envId, { settings, loaded: true });
}

/** Retry button of the Settings page: reloads the environment the page edits. */
export function retryServerSettings(): Promise<void> {
  const target = targetEnv(undefined);
  setEntry(target, { ...entryOf(useServerSettings.getState(), target), error: undefined });
  return loadServerSettings(target).catch(() => undefined);
}

type Nullable<T> = T | null | undefined;

/** A patch's sub-object without keys explicitly set to `undefined`, so spreading it never blanks a field. */
function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `null` clears an optional field, `undefined` keeps it. */
function clearable<T extends object, K extends keyof T>(base: T, key: K, value: Nullable<T[K]>): T {
  if (value === undefined) return base;
  const { [key]: _dropped, ...rest } = base;
  return (value === null ? rest : { ...rest, [key]: value }) as T;
}

/**
 * The local view of a patch: what the server will answer, minus the key itself. Starts from the
 * current settings so a field this function does not know about is kept, never dropped; only
 * patched keys are overridden, and only the special cases below need more than a spread.
 */
export function applyPatch(settings: UserSettings, patch: UserSettingsPatch): UserSettings {
  const next: UserSettings = { ...settings };
  if (patch.providerDefaults !== undefined) next.providerDefaults = patch.providerDefaults;
  if (patch.worktreeByDefault !== undefined) next.worktreeByDefault = patch.worktreeByDefault;
  if (patch.continueAfterRestart !== undefined) next.continueAfterRestart = patch.continueAfterRestart;
  if (patch.followUpMode !== undefined) next.followUpMode = patch.followUpMode;
  if (patch.limitPolicy !== undefined) next.limitPolicy = patch.limitPolicy;
  if (patch.teams !== undefined) next.teams = patch.teams;
  if (patch.providerInstances !== undefined) next.providerInstances = patch.providerInstances;
  if (patch.inbox !== undefined) next.inbox = { ...settings.inbox, ...defined(patch.inbox) };
  if (patch.git !== undefined) next.git = { ...settings.git, ...defined(patch.git) };
  if (patch.glassBox !== undefined) next.glassBox = { ...settings.glassBox, ...defined(patch.glassBox) };
  // the whole map is replaced; an empty value means "back to the default"
  if (patch.keybindings !== undefined) next.keybindings = Object.fromEntries(Object.entries(patch.keybindings).filter(([, v]) => v !== ""));
  if (patch.decisions !== undefined) {
    // the key itself never comes back: `hasKey` stays the server's word until it answers
    const { apiKey: _apiKey, fallback, sites, ...rest } = patch.decisions;
    const decisions = { ...settings.decisions, ...defined(rest), hasKey: settings.decisions.hasKey, sites: { ...settings.decisions.sites, ...defined(sites) } };
    next.decisions = clearable(decisions, "fallback", fallback);
  }
  if (patch.environment !== undefined) {
    const { sshHost, projectsDir, ...rest } = patch.environment;
    next.environment = clearable(clearable({ ...settings.environment, ...defined(rest) }, "sshHost", sshHost), "projectsDir", projectsDir);
  }
  const relay = patch.relay == null ? patch.relay : { url: patch.relay.url, hasKey: patch.relay.key !== undefined || settings.relay?.hasKey === true };
  return clearable(clearable(clearable(next, "relay", relay), "textModel", patch.textModel), "titleInstructions", patch.titleInstructions);
}

/**
 * Optimistic: the change shows at once, the server's answer replaces it, and a
 * refusal puts the previous settings back with a toast. Goes to `envId`, else the
 * environment the open Settings page selected, else the primary.
 */
export async function patchServerSettings(patch: UserSettingsPatch, envId?: string): Promise<void> {
  const target = targetEnv(envId);
  // R19: a limited device may not write settings; say why instead of a failed save
  const limit = deviceLimitOf(target);
  if (limit !== undefined) {
    showToast(limit);
    return;
  }
  const previous = entryOf(useServerSettings.getState(), target);
  // a list-replacing field (teams, providerInstances, keybindings) sent now would overwrite the server's
  if (!previous.loaded) {
    showToast("Settings are still loading");
    return;
  }
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
  useServerSettings.setState({ settings: defaultUserSettings(), loaded: false, error: undefined, byEnv: {}, selectedId: undefined });
}
