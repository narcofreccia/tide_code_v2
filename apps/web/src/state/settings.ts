import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderKind, RuntimeMode } from "@tide/contracts";

export type Theme = "system" | "dark" | "light";
export type Density = "comfortable" | "compact";

export const THEMES: Theme[] = ["system", "dark", "light"];
export const DENSITIES: Density[] = ["comfortable", "compact"];

interface SettingsState {
  theme: Theme;
  density: Density;
  /** Git: pre-checks "use worktree" in the new-thread and plan pickers */
  worktreeByDefault: boolean;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setWorktreeByDefault: (value: boolean) => void;
}

export const SETTINGS_STORAGE_KEY = "tide.settings";
/** Shown until `server.info` answers with the server's own `worktreeRoot`. */
export const DEFAULT_WORKTREE_ROOT = "~/.tide/worktrees";
/** Fired whenever the explicit theme changes, so Monaco/xterm can re-read tokens. */
export const THEME_EVENT = "tide:theme";

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      density: "comfortable",
      worktreeByDefault: true,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setWorktreeByDefault: (worktreeByDefault) => set({ worktreeByDefault }),
    }),
    { name: SETTINGS_STORAGE_KEY },
  ),
);

/**
 * Tokens stay the single source of truth: this only stamps `data-theme` /
 * `data-density` on `<html>`, which `styles/tokens.css` keys off.
 */
export function applyAppearance(theme: Theme, density: Density): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.dataset.density = density;
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** The theme actually painted right now: `system` resolves against the OS. */
export function effectiveTheme(theme: Theme = useSettings.getState().theme): "dark" | "light" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * The ⌘⇧L / top-bar toggle. From `system` it resolves what is on screen first,
 * so the first press always visibly flips.
 */
export function toggleTheme(): "dark" | "light" {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  useSettings.getState().setTheme(next);
  return next;
}

function sync(state: SettingsState): void {
  applyAppearance(state.theme, state.density);
}

sync(useSettings.getState());
useSettings.subscribe(sync);

// ---- per-provider defaults ----

export interface ProviderDefault {
  /** empty string means "let the harness choose" */
  model?: string;
  mode?: RuntimeMode;
}

interface ProviderDefaultsState {
  defaults: Partial<Record<ProviderKind, ProviderDefault>>;
  setProviderDefault: (kind: ProviderKind, patch: ProviderDefault) => void;
}

export const PROVIDER_DEFAULTS_STORAGE_KEY = "tide.providerDefaults";

export const useProviderDefaults = create<ProviderDefaultsState>()(
  persist(
    (set) => ({
      defaults: {},
      setProviderDefault: (kind, patch) =>
        set((s) => ({ defaults: { ...s.defaults, [kind]: { ...s.defaults[kind], ...patch } } })),
    }),
    { name: PROVIDER_DEFAULTS_STORAGE_KEY },
  ),
);

export function providerDefault(kind: ProviderKind): ProviderDefault {
  return useProviderDefaults.getState().defaults[kind] ?? {};
}

export function resetSettings(): void {
  useSettings.setState({ theme: "dark", density: "comfortable", worktreeByDefault: true });
  useProviderDefaults.setState({ defaults: {} });
}
