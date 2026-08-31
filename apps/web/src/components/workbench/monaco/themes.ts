import { THEME_EVENT } from "../../../state/settings.ts";
import type * as Monaco from "monaco-editor";

/** Mirrors `styles/tokens.css`; Monaco needs literal hex, so the palettes live here. */
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

/** Idempotent: registering the same theme twice is harmless but pointless. */
let defined = false;

export function defineThemes(monaco: typeof Monaco): void {
  if (defined) return;
  defined = true;
  monaco.editor.defineTheme(DARK_THEME, theme("vs-dark", DARK));
  monaco.editor.defineTheme(LIGHT_THEME, theme("vs", LIGHT));
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
