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
  /** `--selection` as `#rrggbbaa`: the current-line highlight */
  selection: string;
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
  selection: "#5b9dff1a",
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
  selection: "#2f6fe01a",
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
      "editor.lineHighlightBackground": p.selection,
      "editor.lineHighlightBorder": "#00000000",
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
    selection: alphaHex(liveToken("--selection", fallback.selection), fallback.selection),
  };
}

/** `rgba(r, g, b, a)` / `#rgb(a)` → `#rrggbbaa`, which Monaco takes for translucent colours. */
export function alphaHex(input: string, fallback: string): string {
  const rgba = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(input.trim());
  if (rgba) {
    const h = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    const raw = rgba[4];
    const a = raw === undefined ? 1 : raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    return `#${h(Number(rgba[1]))}${h(Number(rgba[2]))}${h(Number(rgba[3]))}${h(a * 255)}`;
  }
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(input.trim())) return input.trim();
  const hex = colorToHex(input);
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
}

export interface EditorFont {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/** The editor on the type scale: `--fs-sm` mono for text and gutter, a 1.5 line height from that size. */
export function editorFont(): EditorFont {
  const size = Number.parseFloat(liveToken("--fs-sm", "12px"));
  const fontSize = Number.isFinite(size) && size > 0 ? size : 12;
  return {
    fontFamily: liveToken("--font-mono", 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'),
    fontSize,
    lineHeight: Math.round(fontSize * 1.5),
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
