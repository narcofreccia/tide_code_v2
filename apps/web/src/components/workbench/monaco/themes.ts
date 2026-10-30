import { THEME_EVENT } from "../../../state/settings.ts";
import { liveToken } from "../../../lib/theme.ts";
import { blend, colorToHex, isDarkColor } from "../../../lib/vscodeTheme.ts";
import type * as Monaco from "monaco-editor";

/** Static fallbacks for `styles/tokens.css`; Monaco needs literal hex, and the live tokens (custom themes included) are read over them. */
interface Palette {
  bg: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accentSoft: string;
  added: string;
  removed: string;
}

const DARK: Palette = {
  bg: "#16191f",
  surface2: "#1d222a",
  border: "#272d37",
  text: "#e6e9ef",
  muted: "#8b93a3",
  accentSoft: "#1c2b44",
  added: "#12301f",
  removed: "#3a1a1a",
};

const LIGHT: Palette = {
  bg: "#ffffff",
  surface2: "#e9edf3",
  border: "#ccd3de",
  text: "#131722",
  muted: "#6a7285",
  accentSoft: "#e2ecfd",
  added: "#e2f5e9",
  removed: "#fbe3e3",
};

export const DARK_THEME = "tide-dark";
export const LIGHT_THEME = "tide-light";

function theme(base: "vs" | "vs-dark", p: Palette): Monaco.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    rules: [{ token: "", foreground: p.text.slice(1), background: p.bg.slice(1) }],
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.text,
      "editorGutter.background": p.bg,
      "editorLineNumber.foreground": p.muted,
      "editorLineNumber.activeForeground": p.text,
      "editor.lineHighlightBackground": p.surface2,
      "editorWidget.background": p.surface2,
      "editorWidget.border": p.border,
      "editorOverviewRuler.border": p.border,
      "diffEditor.border": p.border,
      "diffEditor.insertedTextBackground": `${p.added}cc`,
      "diffEditor.removedTextBackground": `${p.removed}cc`,
      "scrollbarSlider.background": `${p.border}aa`,
      "focusBorder": p.accentSoft,
    },
  };
}

/** The painted tokens as a Palette, so a custom theme reaches the editor. */
export function livePalette(fallback: Palette): Palette {
  const hex = (token: string, base: string): string => colorToHex(liveToken(token, base));
  const bg = hex("--bg", fallback.bg);
  return {
    bg,
    surface2: hex("--surface-2", fallback.surface2),
    border: hex("--border", fallback.border),
    text: hex("--text", fallback.text),
    muted: hex("--muted", fallback.muted),
    accentSoft: blend(hex("--accent", fallback.accentSoft), bg, 0.2),
    added: blend(hex("--ok", fallback.added), bg, 0.2),
    removed: blend(hex("--danger", fallback.removed), bg, 0.2),
  };
}

let registered: typeof Monaco | undefined;

/** Defines both names; the one in use is built from the live tokens and re-defined on `THEME_EVENT`. */
function define(monaco: typeof Monaco): void {
  const active = preferredTheme();
  const live = livePalette(active === LIGHT_THEME ? LIGHT : DARK);
  const base = isDarkColor(live.bg) ? "vs-dark" : "vs";
  monaco.editor.defineTheme(DARK_THEME, active === DARK_THEME ? theme(base, live) : theme("vs-dark", DARK));
  monaco.editor.defineTheme(LIGHT_THEME, active === LIGHT_THEME ? theme(base, live) : theme("vs", LIGHT));
  monaco.editor.setTheme(active);
}

export function defineThemes(monaco: typeof Monaco): void {
  if (registered === monaco) return;
  registered = monaco;
  define(monaco);
  window.addEventListener(THEME_EVENT, () => define(monaco));
}

/** Explicit choice (Settings › Appearance) first, else the OS colour scheme. */
export function preferredTheme(): string {
  if (typeof window === "undefined") return DARK_THEME;
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light") return LIGHT_THEME;
  if (explicit === "dark") return DARK_THEME;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? LIGHT_THEME : DARK_THEME;
}

/** Notifies on both the OS preference and the explicit setting changing. */
export function subscribeTheme(onChange: () => void): () => void {
  const query = window.matchMedia?.("(prefers-color-scheme: light)");
  query?.addEventListener("change", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    query?.removeEventListener("change", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}
