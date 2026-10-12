/**
 * Plan-mode shell gate: is this command read-only enough to run while planning?
 *
 * Parse-and-deny, not pattern matching on the raw string. The command is tokenized with POSIX
 * quoting (so a `>` inside a grep pattern is a word, not a redirection), split into simple
 * commands on `|`, `||`, `&&`, `;`, `&` and newlines, and every simple command must be an
 * allowlisted program whose arguments carry none of that program's mutating flags. Anything
 * the tokenizer cannot model (command/process substitution, heredocs, unknown programs) answers
 * `false`, which only means "take the normal approval path" — this decides plan-mode blocking,
 * never whether an approval is needed.
 */

type Token = { kind: "word"; value: string } | { kind: "op"; value: string };

/** Redirection targets that discard or duplicate output without touching a file. */
const HARMLESS_TARGETS = new Set(["/dev/null", "&1", "&2", "-"]);

/** Splits a command line into words and operators; undefined = something we refuse to model. */
export function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = (): void => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return undefined;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j += 1) {
        const c = command[j]!;
        if (c === "`" || (c === "$" && command[j + 1] === "(")) return undefined;
        if (c === "\\" && j + 1 < command.length) {
          j += 1;
          word += command[j];
          continue;
        }
        word += c;
      }
      if (j >= command.length) return undefined;
      inWord = true;
      i = j;
      continue;
    }
    if (ch === "\\") {
      if (next === undefined) return undefined;
      i += 1;
      if (next === "\n") continue; // line continuation
      word += next;
      inWord = true;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) return undefined;
    if ((ch === "<" || ch === ">") && next === "(") return undefined; // process substitution
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      // `2>&1` and `&>` are redirections, handled below
      if (ch === "&" && next === ">") {
        flush();
        const append = command[i + 2] === ">";
        tokens.push({ kind: "op", value: append ? "&>>" : "&>" });
        i += append ? 2 : 1;
        continue;
      }
      flush();
      const pair = `${ch}${next ?? ""}`;
      if (pair === "||" || pair === "&&" || pair === "|&" || pair === ";;") {
        tokens.push({ kind: "op", value: pair });
        i += 1;
      } else tokens.push({ kind: "op", value: ch === "\n" ? ";" : ch });
      continue;
    }
    if (ch === ">" || ch === "<") {
      // a numeric fd prefix (`2>`) belongs to the operator, not to the previous word
      let op = ch;
      if (inWord && /^\d+$/.test(word)) {
        op = `${word}${ch}`;
        word = "";
        inWord = false;
      }
      flush();
      if (next === ch || (ch === ">" && (next === "|" || next === "&")) || (ch === "<" && next === "&")) {
        op += next;
        i += 1;
      }
      if (op.endsWith("<<")) return undefined; // heredoc: body is not on this line
      tokens.push({ kind: "op", value: op });
      continue;
    }
    word += ch;
    inWord = true;
  }
  flush();
  return tokens;
}

const SEPARATORS = new Set([";", "|", "||", "&&", "&", "|&"]);

/** Splits tokens into simple commands; undefined when a redirection writes to a file. */
function simpleCommands(tokens: Token[]): string[][] | undefined {
  const commands: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "word") {
      current.push(token.value);
      continue;
    }
    if (SEPARATORS.has(token.value)) {
      commands.push(current);
      current = [];
      continue;
    }
    // a redirection: input (`<`) is a read; output is only allowed to a harmless target
    const target = tokens[i + 1];
    const isInput = token.value.endsWith("<") || token.value.endsWith("<&");
    if (token.value.endsWith("&") && target?.kind === "word" && /^\d+$|^-$/.test(target.value)) {
      i += 1; // `2>&1`, `>&2`
      continue;
    }
    if (target?.kind !== "word") return undefined;
    if (!isInput && !HARMLESS_TARGETS.has(target.value)) return undefined;
    i += 1;
  }
  commands.push(current);
  return commands;
}

type ArgCheck = (args: string[]) => boolean;

const hasFlag = (args: string[], ...flags: string[]): boolean =>
  args.some((arg) => flags.some((flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`))));
/** Short-option cluster check: `-in` contains `i`. Long options never match. */
const hasShort = (args: string[], letter: string): boolean => args.some((arg) => /^-[A-Za-z]+/.test(arg) && !arg.startsWith("--") && arg.slice(1).includes(letter));
const positionals = (args: string[]): string[] => args.filter((arg) => !arg.startsWith("-"));

/** `sed`: no in-place edit, and no `w`/`W` (write file) or `e` (execute) commands in the script. */
const SED_WRITE = /(^|[;{}\n]|\d|\$|\/)\s*[wWe](\s|$)|s(.)(?:(?!\3).|\\.)*\3(?:(?!\3).|\\.)*\3[gpiImM0-9]*[we]/;
function sedOk(args: string[]): boolean {
  if (hasShort(args, "i") || hasFlag(args, "--in-place", "--file", "-f")) return false;
  if (args.some((arg) => arg.startsWith("--in-place"))) return false;
  return !args.some((arg) => !arg.startsWith("-") && SED_WRITE.test(arg));
}

const FIND_MUTATING = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
// `system(…)`, `cmd | getline`, `print | "cmd"`, `print > "file"`, `|&` coprocesses
const AWK_UNSAFE = /\bsystem\s*\(|\|\s*(getline\b|&|")|\|&|\bprintf?\b[^;}]*>/;
/** `awk`: no `system()`, no pipes to commands, no `print > file`, no in-place / program files. */
function awkOk(args: string[]): boolean {
  if (hasFlag(args, "-f", "--file", "-i", "--include", "-E", "--exec")) return false;
  return !args.some((arg) => AWK_UNSAFE.test(arg));
}

const GIT_BRANCH_MUTATING = ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description", "--track", "--no-track", "--create-reflog"];
const GIT_BRANCH_LIST = ["-l", "--list", "-a", "--all", "-r", "--remotes", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--show-current"];
function gitBranchOk(args: string[]): boolean {
  if (args.some((arg) => GIT_BRANCH_MUTATING.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) return false;
  if (args.some((arg) => /^-[a-zA-Z]+$/.test(arg) && /[dDmMcCfu]/.test(arg.slice(1)))) return false;
  // `git branch <name>` creates a branch; names are only patterns/commits in list mode
  return positionals(args).length === 0 || hasFlag(args, ...GIT_BRANCH_LIST);
}

const GIT_CONFIG_READ = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list"];
const GIT_CONFIG_WRITE = ["--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"];
function gitConfigOk(args: string[]): boolean {
  if (hasFlag(args, ...GIT_CONFIG_WRITE)) return false;
  const [sub] = positionals(args);
  if (sub === "get" || sub === "list") return true;
  if (sub === "set" || sub === "unset" || sub === "edit" || sub === "rename-section" || sub === "remove-section") return false;
  if (hasFlag(args, ...GIT_CONFIG_READ)) return true;
  // legacy form: one positional reads a key, two set it
  return positionals(args.filter((arg, i) => !(args[i - 1] === "--file" || args[i - 1] === "-f" || args[i - 1] === "--type"))).length <= 1;
}

function gitRemoteOk(args: string[]): boolean {
  const [sub] = positionals(args);
  return sub === undefined || sub === "show" || sub === "get-url";
}

const GIT_READ: Record<string, ArgCheck> = {
  status: () => true,
  log: () => true,
  diff: () => true,
  show: () => true,
  blame: () => true,
  describe: () => true,
  "ls-files": () => true,
  "ls-tree": () => true,
  "rev-parse": () => true,
  "cat-file": () => true,
  shortlog: () => true,
  branch: gitBranchOk,
  config: gitConfigOk,
  remote: gitRemoteOk,
};
function gitOk(args: string[]): boolean {
  // anything before the subcommand (`-c key=val`, `-C dir`, `--git-dir`) is refused outright
  const [sub, ...rest] = args;
  if (sub === undefined) return false;
  const check = GIT_READ[sub];
  if (!check) return false;
  // `--output=<file>` makes log/diff/show write a file
  if (hasFlag(rest, "--output", "-o") && sub !== "branch") return false;
  return check(rest);
}

/** `env [flags] [NAME=value]... [cmd]`: prints the environment, or runs `cmd` — which must pass too. */
function envOk(args: string[]): boolean {
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-0" || arg === "--null" || arg === "-i" || arg === "--ignore-environment" || arg === "-") continue;
    if (arg.startsWith("-")) return false; // -u/-C/-S/--split-string take values or run things
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    break;
  }
  const rest = args.slice(i);
  return rest.length === 0 || commandOk(rest);
}

const ALWAYS = (): boolean => true;
const READ_ONLY_PROGRAMS: Record<string, ArgCheck> = {
  ls: ALWAYS,
  cat: ALWAYS,
  head: ALWAYS,
  tail: (args) => !hasFlag(args, "-f", "-F", "--follow"),
  wc: ALWAYS,
  grep: ALWAYS,
  egrep: ALWAYS,
  fgrep: ALWAYS,
  rg: (args) => !hasFlag(args, "--pre"),
  find: (args) => !args.some((arg) => FIND_MUTATING.has(arg)),
  fd: (args) => !hasFlag(args, "-x", "--exec", "-X", "--exec-batch"),
  pwd: ALWAYS,
  which: ALWAYS,
  echo: ALWAYS,
  printf: ALWAYS,
  file: (args) => !hasShort(args, "C") && !hasFlag(args, "--compile"),
  stat: ALWAYS,
  tree: (args) => !hasFlag(args, "-o"),
  du: ALWAYS,
  df: ALWAYS,
  diff: ALWAYS,
  sort: (args) => !hasFlag(args, "-o", "--output") && !args.some((arg) => /^-[a-zA-Z]*o/.test(arg) && !arg.startsWith("--")),
  uniq: (args) => positionals(args).length <= 1,
  cut: ALWAYS,
  tr: ALWAYS,
  nl: ALWAYS,
  awk: awkOk,
  gawk: awkOk,
  sed: sedOk,
  basename: ALWAYS,
  dirname: ALWAYS,
  realpath: ALWAYS,
  readlink: ALWAYS,
  env: envOk,
  printenv: ALWAYS,
  date: (args) => !hasFlag(args, "-s", "--set"),
  true: ALWAYS,
  git: gitOk,
};

function commandOk(words: string[]): boolean {
  const [head, ...args] = words;
  if (head === undefined) return false;
  const check = READ_ONLY_PROGRAMS[head];
  return check !== undefined && check(args);
}

/** True only when every simple command in `command` is a recognised read-only invocation. */
export function isReadOnlyShell(command: string): boolean {
  if (command.trim() === "") return false;
  const tokens = tokenize(command);
  if (!tokens) return false;
  const commands = simpleCommands(tokens);
  if (!commands) return false;
  const nonEmpty = commands.filter((words) => words.length > 0);
  return nonEmpty.length > 0 && nonEmpty.every((words) => commandOk(words));
}
