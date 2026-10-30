/** Maps a VS Code colour theme onto Tide's tokens. Pure: no DOM access. */

export type TokenMap = Record<string, string>;

export interface ImportedTheme {
  name: string;
  scheme: "dark" | "light";
  tokens: TokenMap;
}

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` → [r,g,b] (alpha dropped), or undefined. */
export function parseColor(input: string | undefined): Rgb | undefined {
  if (!input) return undefined;
  const c = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(c)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16)) as Rgb;
    }
    if (hex.length === 6 || hex.length === 8) {
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
    }
    return undefined;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(c)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) return parts.map((n) => Math.max(0, Math.min(255, Math.round(n)))) as Rgb;
  }
  return undefined;
}

const h2 = (n: number): string => n.toString(16).padStart(2, "0");

/** Any colour we can parse as `#rrggbb`; unparseable input comes back untouched. */
export function colorToHex(input: string): string {
  const rgb = parseColor(input);
  return rgb ? `#${rgb.map(h2).join("")}` : input;
}

/** `fg` laid over `bg` at `amount` (0..1), as `#rrggbb`. */
export function blend(fg: string, bg: string, amount: number): string {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) return fg;
  return `#${a.map((v, i) => h2(Math.round(v * amount + b[i]! * (1 - amount)))).join("")}`;
}

export function isDarkColor(color: string): boolean {
  const rgb = parseColor(color);
  if (!rgb) return true;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5;
}

/** VS Code theme files are JSONC: strip comments and trailing commas, leaving strings alone. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** token → VS Code colour keys, first present wins. */
const DIRECT: Array<[string, string[]]> = [
  ["--bg", ["editor.background"]],
  ["--surface", ["sideBar.background"]],
  ["--surface-2", ["editorWidget.background"]],
  ["--surface-raised", ["dropdown.background", "menu.background"]],
  ["--border", ["panel.border"]],
  ["--border-strong", ["focusBorder"]],
  ["--text", ["foreground", "editor.foreground"]],
  ["--text-2", ["descriptionForeground"]],
  ["--muted", ["descriptionForeground"]],
  ["--accent", ["button.background", "textLink.foreground"]],
  ["--on-accent", ["button.foreground"]],
  ["--danger", ["errorForeground"]],
  ["--ok", ["terminal.ansiGreen"]],
  ["--warn", ["terminal.ansiYellow"]],
];

const SOFT_AMOUNT = 0.16;
/** status token → the base token it follows (limited/interrupted have no VS Code analogue and keep the current colour) */
const STATUS: Array<[string, string]> = [
  ["--st-running", "--accent"],
  ["--st-needs", "--warn"],
  ["--st-error", "--danger"],
  ["--st-ok", "--ok"],
  ["--st-idle", "--muted"],
];
const SOFT_OF: Array<[string, string]> = [
  ["--accent-soft", "--accent"],
  ["--danger-soft", "--danger"],
  ["--st-limited-soft", "--st-limited"],
  ["--st-interrupted-soft", "--st-interrupted"],
];

/**
 * `fallback` supplies the current value for every token the theme leaves out.
 * Throws a readable Error when the input is not a theme.
 */
export function importVscodeTheme(source: string | unknown, fallback: TokenMap, fileName = "Imported theme"): ImportedTheme {
  let json: unknown;
  try {
    json = typeof source === "string" ? parseJsonc(source) : source;
  } catch {
    throw new Error("Not valid JSON");
  }
  const doc = json as { name?: unknown; type?: unknown; colors?: unknown } | null;
  const colors = doc && typeof doc === "object" ? doc.colors : undefined;
  if (!colors || typeof colors !== "object") throw new Error("No `colors` map: this is not a VS Code colour theme");
  const map = colors as Record<string, unknown>;
  const pick = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = map[key];
      if (typeof v === "string" && parseColor(v)) return colorToHex(v);
    }
    return undefined;
  };

  const tokens: TokenMap = { ...fallback };
  for (const [token, keys] of DIRECT) {
    const value = pick(keys);
    if (value !== undefined) tokens[token] = value;
  }
  const bg = tokens["--bg"] ?? "#000000";
  for (const [token, base] of STATUS) if (tokens[base]) tokens[token] = tokens[base]!;
  for (const [soft, base] of SOFT_OF) if (tokens[base]) tokens[soft] = blend(tokens[base]!, bg, SOFT_AMOUNT);
  for (const [token] of STATUS) tokens[`${token}-soft`] = blend(tokens[token] ?? "", bg, SOFT_AMOUNT);

  const type = typeof doc?.type === "string" ? doc.type.toLowerCase() : "";
  const scheme = type.includes("light") ? "light" : type.includes("dark") ? "dark" : isDarkColor(bg) ? "dark" : "light";
  const name = typeof doc?.name === "string" && doc.name.trim() !== "" ? doc.name.trim() : fileName;
  return { name, scheme, tokens };
}
