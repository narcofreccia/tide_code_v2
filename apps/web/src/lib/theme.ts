import type { TokenMap } from "./vscodeTheme.ts";

/**
 * Custom theme and font application. This file holds the one sanctioned inline-style
 * exception in the web app: custom colours and fonts are user data, so they are written
 * as custom properties on `<html>` with `style.setProperty` (and removed again on clear).
 * Everything else stays in CSS modules reading the same tokens.
 */

export interface CustomTheme {
  name: string;
  scheme?: "dark" | "light";
  tokens: TokenMap;
}

export type FontSize = 12 | 13 | 14 | 15;
export const FONT_SIZES: FontSize[] = [12, 13, 14, 15];

export interface FontSettings {
  ui?: string;
  mono?: string;
  size: FontSize;
}

export const DEFAULT_FONTS: FontSettings = { size: 13 };

/** Every colour token a custom theme may set. */
export const THEME_TOKENS = [
  "--bg", "--surface", "--surface-2", "--surface-raised", "--border", "--border-strong", "--text", "--text-2",
  "--muted", "--accent", "--accent-soft", "--on-accent", "--danger", "--danger-soft", "--ok", "--warn",
  "--shadow-pop",
  "--st-running", "--st-running-soft", "--st-needs", "--st-needs-soft", "--st-error", "--st-error-soft",
  "--st-ok", "--st-ok-soft", "--st-limited", "--st-limited-soft", "--st-idle", "--st-idle-soft",
  "--st-interrupted", "--st-interrupted-soft",
];

/** Used only when the live value cannot be read (tests, no stylesheet): tokens.css dark. */
export const DEFAULT_DARK_TOKENS: TokenMap = {
  "--bg": "#0b0d10", "--surface": "#13161b", "--surface-2": "#1b2028", "--surface-raised": "#232934",
  "--border": "#272d37", "--border-strong": "#38404d", "--text": "#e6e9ef", "--text-2": "#b3bac7",
  "--muted": "#8b93a3", "--accent": "#5b9dff", "--accent-soft": "rgba(91, 157, 255, 0.16)", "--on-accent": "#fff",
  "--danger": "#ef6a6a", "--danger-soft": "rgba(239, 106, 106, 0.16)", "--ok": "#4ec9a0", "--warn": "#e2b341",
  "--shadow-pop": "0 8px 24px rgb(0 0 0 / 0.35)",
  "--st-running": "#5b9dff", "--st-running-soft": "rgba(91, 157, 255, 0.16)", "--st-needs": "#f2a93b",
  "--st-needs-soft": "rgba(242, 169, 59, 0.16)", "--st-error": "#ef6a6a", "--st-error-soft": "rgba(239, 106, 106, 0.16)",
  "--st-ok": "#4ec9a0", "--st-ok-soft": "rgba(78, 201, 160, 0.15)", "--st-limited": "#a78bfa",
  "--st-limited-soft": "rgba(167, 139, 250, 0.16)", "--st-idle": "#8b93a3", "--st-idle-soft": "rgba(139, 147, 163, 0.14)",
  "--st-interrupted": "#e0794f", "--st-interrupted-soft": "rgba(224, 121, 79, 0.16)",
};

const FONT_VARS = ["--font", "--font-mono", "--font-size-base"];

function root(): HTMLElement | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement;
}

function removeThemeProperties(el: HTMLElement): void {
  for (const name of THEME_TOKENS) el.style.removeProperty(name);
  el.style.removeProperty("color-scheme");
}

/** Sets a custom theme's tokens on `<html>`; `undefined` removes every one it set. */
export function applyCustomTheme(theme: CustomTheme | undefined): void {
  const el = root();
  if (!el) return;
  removeThemeProperties(el);
  if (!theme) return;
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (name.startsWith("--")) el.style.setProperty(name, value);
  }
  if (theme.scheme) el.style.setProperty("color-scheme", theme.scheme);
}

/** Family strings are user text: refuse anything that could close the declaration. */
export function safeFamily(value: string): string | undefined {
  const v = value.trim();
  return v === "" || /[;{}<>]/.test(v) ? undefined : v;
}

export function applyFonts(fonts: FontSettings): void {
  const el = root();
  if (!el) return;
  for (const name of FONT_VARS) el.style.removeProperty(name);
  const ui = fonts.ui ? safeFamily(fonts.ui) : undefined;
  const mono = fonts.mono ? safeFamily(fonts.mono) : undefined;
  if (ui) el.style.setProperty("--font", ui);
  if (mono) el.style.setProperty("--font-mono", mono);
  if (fonts.size !== DEFAULT_FONTS.size) el.style.setProperty("--font-size-base", `${fonts.size}px`);
}

/**
 * The theme's own token values with any custom overrides taken out for the read, so an
 * import falls back to the stock palette rather than to the previous import.
 */
export function readBaseTokens(): TokenMap {
  const el = root();
  if (!el) return { ...DEFAULT_DARK_TOKENS };
  const saved = THEME_TOKENS.map((name) => [name, el.style.getPropertyValue(name)] as const);
  for (const [name] of saved) el.style.removeProperty(name);
  const computed = getComputedStyle(el);
  const out: TokenMap = {};
  for (const name of THEME_TOKENS) out[name] = computed.getPropertyValue(name).trim() || DEFAULT_DARK_TOKENS[name]!;
  for (const [name, value] of saved) if (value) el.style.setProperty(name, value);
  return out;
}

/** Current painted value of one token (custom or stock), or `fallback`. */
export function liveToken(name: string, fallback: string): string {
  const el = root();
  if (!el) return fallback;
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}
