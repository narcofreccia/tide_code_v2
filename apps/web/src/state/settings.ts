import { create } from "zustand";
import { persist } from "zustand/middleware";
import { resetServerSettings } from "./serverSettings.ts";
import { DEFAULT_FONTS, applyCustomTheme, applyFonts, type CustomTheme, type FontSettings } from "../lib/theme.ts";

export type Theme = "system" | "dark" | "light";
export type Density = "comfortable" | "compact";

export const THEMES: Theme[] = ["system", "dark", "light"];
export const DENSITIES: Density[] = ["comfortable", "compact"];

interface SettingsState {
  theme: Theme;
  density: Density;
  /** an imported VS Code theme laid over the stock tokens; per device */
  customTheme?: CustomTheme;
  fonts: FontSettings;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setCustomTheme: (theme: CustomTheme | undefined) => void;
  setFonts: (patch: { ui?: string | undefined; mono?: string | undefined; size?: FontSettings["size"] }) => void;
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
      fonts: DEFAULT_FONTS,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setCustomTheme: (customTheme) =>
        set((s) => {
          const { customTheme: _drop, ...rest } = s;
          return customTheme ? { ...rest, customTheme } : rest;
        }, true),
      setFonts: (patch) =>
        set((s) => {
          const fonts = { ...s.fonts, ...patch } as FontSettings;
          if (!fonts.ui) delete fonts.ui;
          if (!fonts.mono) delete fonts.mono;
          return { fonts };
        }),
    }),
    // provider defaults and worktreeByDefault moved to the server (state/serverSettings.ts)
    { name: SETTINGS_STORAGE_KEY, partialize: (s) => ({
        theme: s.theme,
        density: s.density,
        fonts: s.fonts,
        ...(s.customTheme ? { customTheme: s.customTheme } : {}),
      }), },
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
  applyCustomTheme(state.customTheme);
  applyFonts(state.fonts);
  applyAppearance(state.theme, state.density);
}

sync(useSettings.getState());
useSettings.subscribe(sync);

export function resetSettings(): void {
  const { customTheme: _drop, ...rest } = useSettings.getState();
  useSettings.setState({ ...rest, theme: "dark", density: "comfortable", fonts: DEFAULT_FONTS }, true);
  resetServerSettings();
}
