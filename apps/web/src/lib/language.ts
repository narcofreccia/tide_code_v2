/** Human label for the status bar, without pulling monaco into the shell chunk. */
const LABELS: [RegExp, string][] = [
  [/\.tsx$/i, "TypeScript React"],
  [/\.(ts|mts|cts)$/i, "TypeScript"],
  [/\.jsx$/i, "JavaScript React"],
  [/\.(js|mjs|cjs)$/i, "JavaScript"],
  [/\.(json|jsonc|json5)$/i, "JSON"],
  [/\.css$/i, "CSS"],
  [/\.(scss|sass)$/i, "SCSS"],
  [/\.less$/i, "Less"],
  [/\.html?$/i, "HTML"],
  [/\.(md|mdx)$/i, "Markdown"],
  [/\.(ya?ml)$/i, "YAML"],
  [/\.toml$/i, "TOML"],
  [/\.rs$/i, "Rust"],
  [/\.go$/i, "Go"],
  [/\.py$/i, "Python"],
  [/\.rb$/i, "Ruby"],
  [/\.(sh|bash|zsh)$/i, "Shell"],
  [/\.sql$/i, "SQL"],
  [/\.(c|h)$/i, "C"],
  [/\.(cc|cpp|hpp|hxx)$/i, "C++"],
  [/\.java$/i, "Java"],
  [/\.(kt|kts)$/i, "Kotlin"],
  [/\.swift$/i, "Swift"],
  [/\.xml$/i, "XML"],
  [/\.svg$/i, "SVG"],
];

export function languageLabel(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/^dockerfile$/i.test(name)) return "Dockerfile";
  for (const [re, label] of LABELS) if (re.test(name)) return label;
  return "Plain Text";
}
