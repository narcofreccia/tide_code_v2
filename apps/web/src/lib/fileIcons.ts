/** Text glyphs per file family — no icon pack, no webfont, one character wide. */
const BY_EXTENSION: [RegExp, string][] = [
  [/\.(tsx|jsx)$/i, "⚛"],
  [/\.(ts|mts|cts|js|mjs|cjs)$/i, "◆"],
  [/\.(json|jsonc|json5)$/i, "{}"],
  [/\.(css|scss|less)$/i, "▤"],
  [/\.(html|htm|svg|xml)$/i, "<>"],
  [/\.(md|mdx|txt|rst)$/i, "¶"],
  [/\.(yml|yaml|toml|ini|env|conf)$/i, "⚙"],
  [/\.(rs|go|py|rb|java|kt|swift|c|h|cc|cpp|hpp)$/i, "⌗"],
  [/\.(png|jpe?g|gif|webp|ico|avif)$/i, "▣"],
  [/\.(sh|bash|zsh|fish)$/i, "❯"],
  [/\.(lock|lockb)$/i, "⚿"],
];

const BY_NAME: [RegExp, string][] = [
  [/^\.git(ignore|attributes|modules)$/i, "⑂"],
  [/^(dockerfile|.*\.dockerfile)$/i, "⛴"],
  [/^(license|licence|copying)$/i, "§"],
  [/^(package\.json|pnpm-workspace\.yaml)$/i, "▦"],
];

export function fileGlyph(path: string, kind: "file" | "dir" | "symlink" = "file"): string {
  if (kind === "dir") return "▸";
  if (kind === "symlink") return "↪";
  const name = path.slice(path.lastIndexOf("/") + 1);
  for (const [re, glyph] of BY_NAME) if (re.test(name)) return glyph;
  for (const [re, glyph] of BY_EXTENSION) if (re.test(name)) return glyph;
  return "·";
}
