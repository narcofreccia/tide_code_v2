import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * A server started from Finder/launchd gets launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so the harness CLIs, gh, rg and node on the user's PATH are invisible to everything it spawns.
 * Read the PATH the user's own login shell builds and adopt it once at boot.
 */

const START = "__TIDE_PATH_START__";
const END = "__TIDE_PATH_END__";
const SCRIPT = `echo ${START}; printenv PATH; echo ${END}`;

/** Runs `file args` and resolves with its stdout; rejects on failure or timeout. */
export type ShellRunner = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

/**
 * `detached` gives the shell a session of its own, so it has no terminal. An interactive zsh
 * that finds one takes it over and, on exit, leaves it with our process group: started by the
 * desktop shell from a terminal (`pnpm desktop:dev`), Ctrl-C then reached only this server,
 * which the shell restarts, and the dev session could not be stopped.
 */
export const execRunner: ShellRunner = (file, args, { env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    // stdin is /dev/null: an interactive shell must never wait on ours
    const child = spawn(file, args, { env, timeout: timeoutMs, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => (code === 0 ? resolve(stdout) : reject(new Error(`${file} exited with ${signal ?? code}`))));
  });

export interface ReadShellPathOptions {
  shell: string;
  env: NodeJS.ProcessEnv;
  run?: ShellRunner;
  timeoutMs?: number;
}

function between(output: string): string | undefined {
  const start = output.indexOf(START);
  const end = output.indexOf(END, start + START.length);
  if (start < 0 || end < 0) return undefined;
  const path = output.slice(start + START.length, end).trim();
  return path === "" ? undefined : path;
}

/** The PATH the user's shell reports: `-ilc` (loads .zshrc, so nvm), then `-lc` once. */
export async function readShellPath(options: ReadShellPathOptions): Promise<string | undefined> {
  const run = options.run ?? execRunner;
  for (const flags of ["-ilc", "-lc"]) {
    try {
      const path = between(await run(options.shell, [flags, SCRIPT], { env: options.env, timeoutMs: options.timeoutMs ?? 5_000 }));
      if (path !== undefined) return path;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/** `first` entries, then those of `second` not already present, then well-known dirs. */
export function mergePath(first: string | undefined, second: string | undefined, wellKnown: string[]): string {
  const entries = [...(first ?? "").split(delimiter), ...(second ?? "").split(delimiter), ...wellKnown];
  return [...new Set(entries.filter((entry) => entry !== ""))].join(delimiter);
}

const SYSTEM_DIR = /^\/(usr\/(local\/)?)?s?bin\/?$/;

/** Only system dirs: what launchd or a desktop session hands a GUI app, never a terminal. */
export function isBarePath(path: string | undefined): boolean {
  return (path ?? "").split(delimiter).every((entry) => entry === "" || SYSTEM_DIR.test(entry));
}

export interface ApplyShellPathDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  run?: ShellRunner;
  log?: (line: string) => void;
}

/** Completes `env.PATH` from the login shell on macOS/Linux. Never throws. */
export async function applyShellPath(deps: ApplyShellPathDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  if ((platform !== "darwin" && platform !== "linux") || env["TIDE_NO_SHELL_PATH"] === "1") return;
  const shell = env["SHELL"] || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const home = deps.home ?? homedir();
    const exists = deps.exists ?? existsSync;
    const wellKnown = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".bun", "bin")].filter((dir) => exists(dir));
    const shellPath = await readShellPath({ shell, env: { ...env }, ...(deps.run ? { run: deps.run } : {}) });
    // A bare PATH takes the shell's order (homebrew git before /usr/bin/git, as in the user's terminal).
    // A PATH someone set up (a terminal, a pinned service) keeps its order and only gains what it lacks.
    const inherited = env["PATH"];
    env["PATH"] = isBarePath(inherited) ? mergePath(shellPath, inherited, wellKnown) : mergePath(inherited, shellPath, wellKnown);
    if (shellPath !== undefined) log(`[path] from ${shell}: ${env["PATH"].split(delimiter).length} entries`);
    else log(`[path] could not read PATH from ${shell}; using the inherited PATH plus ${wellKnown.length} well-known dirs`);
  } catch (err) {
    log(`[path] could not read PATH from ${shell}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
