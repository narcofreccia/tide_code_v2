import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const runExecFile = promisify(execFile);

const WIN_EXTS = [".exe", ".cmd", ".bat", ".com"] as const;
const WIN_SCRIPT_EXT = /\.(?:cmd|bat)$/i;
const JS_EXT = /\.(?:js|mjs|cjs)$/i;
const HAS_WIN_EXT = /\.(?:exe|cmd|bat|com)$/i;

/** Case-insensitive PATH lookup on Windows (spreading `process.env` can produce `Path` instead of `PATH`). */
export function pathValue(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return env["PATH"] ?? "";
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && typeof value === "string") return value;
  }
  return "";
}

/** Directories listed on PATH, with empty entries and Windows surrounding quotes removed. */
export function pathEntries(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const sep = platform === "win32" ? ";" : ":";
  return pathValue(env, platform)
    .split(sep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
}

/** Well-known user CLI directories on Windows (npm, pnpm, bun, native installers). */
export function windowsWellKnownDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".antigravity", "bin"),
  ];
  const appData = env["APPDATA"] ?? env["AppData"];
  const localAppData = env["LOCALAPPDATA"] ?? env["LocalAppData"];
  if (appData) dirs.push(join(appData, "npm"));
  if (localAppData) {
    dirs.push(join(localAppData, "pnpm"));
    dirs.push(join(localAppData, "Programs", "Antigravity", "bin"));
  }
  return dirs;
}

function isRunnableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform !== "win32") accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  if (HAS_WIN_EXT.test(name)) return [name];
  return [...WIN_EXTS.map((ext) => `${name}${ext}`), name];
}

export interface FindBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Extra directories searched after PATH (e.g. Windows well-known user bin folders). */
  extraDirs?: readonly string[];
  /** Include `windowsWellKnownDirs()` automatically on Windows (default true). */
  includeWindowsDefaults?: boolean;
  home?: string;
}

/** Checks a single directory for `name` (trying `.exe`/`.cmd`/`.bat`/`.com` first on Windows). */
export function findLocalBinary(dir: string, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  for (const file of candidateNames(name, platform)) {
    const full = join(dir, file);
    if (isRunnableFile(full, platform)) return full;
  }
  return undefined;
}

/**
 * Pure-fs cross-platform replacement for `/usr/bin/env which -a <name>`.
 * Scans PATH (plus Windows well-known user bin dirs) and prefers `.exe` over `.cmd` within each directory.
 */
export function findBinariesOnPath(name: string, options: FindBinaryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(candidate);
  };

  if (name.includes("/") || name.includes("\\")) {
    for (const candidate of candidateNames(name, platform)) {
      if (isRunnableFile(candidate, platform)) add(candidate);
    }
    return results;
  }

  const dirs = [
    ...pathEntries(env, platform),
    ...(options.extraDirs ?? []),
    ...(platform === "win32" && options.includeWindowsDefaults !== false ? windowsWellKnownDirs(env, options.home) : []),
  ];
  for (const dir of dirs) {
    for (const file of candidateNames(name, platform)) {
      const full = join(dir, file);
      if (isRunnableFile(full, platform)) add(full);
    }
  }
  return results;
}

/** First matching executable on PATH (pure-fs replacement for `/usr/bin/env which <name>`). */
export function findBinaryOnPath(name: string, options: FindBinaryOptions = {}): string | undefined {
  return findBinariesOnPath(name, options)[0];
}

/**
 * Extracts the target JS entrypoint from an npm / pnpm / yarn Windows `.cmd` shim
 * (e.g. `"%dp0%\node_modules\@openai\codex\bin\codex.js"`). Running the JS target directly
 * via `node.exe` avoids `cmd.exe` argument-quoting corruption and CVE-2024-27980 `EINVAL`.
 */
export function unwrapCmdShim(cmdPath: string): string | undefined {
  if (!WIN_SCRIPT_EXT.test(cmdPath)) return undefined;
  let content: string;
  try {
    const stat = statSync(cmdPath);
    if (!stat.isFile() || stat.size > 8192) return undefined;
    content = readFileSync(cmdPath, "utf8");
  } catch {
    return undefined;
  }
  // Standard npm/pnpm/yarn cmd-shim: `"%dp0%\node_modules\...\cli.js"` or `"%~dp0\...\cli.js"`
  const match = /"(?:%dp0%|%~dp0)[\\/]([^"]+\.(?:js|mjs|cjs))"/i.exec(content);
  if (!match?.[1]) return undefined;
  const rel = match[1].replaceAll("\\", "/");
  const target = resolve(dirname(cmdPath), rel);
  return existsSync(target) ? target : undefined;
}

export interface PreparedSpawn {
  command: string;
  args: string[];
  shell: boolean;
  windowsHide: boolean;
}

/**
 * Normalises a command + argv for `child_process.spawn` / `execFile` across platforms.
 * On Unix: passes through untouched.
 * On Windows: resolves bare names on PATH (preferring `.exe` over `.cmd`), unwraps Node `.cmd`
 * shims to `node.exe <script.js> ...args` (no `cmd.exe`), falls back to `shell: true` only for
 * non-Node `.cmd`/`.bat` scripts, and sets `windowsHide: true` to suppress flashing console windows.
 */
export function prepareSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PreparedSpawn {
  if (platform !== "win32") {
    return { command, args: [...args], shell: false, windowsHide: false };
  }
  const resolved = !command.includes("/") && !command.includes("\\") ? (findBinaryOnPath(command, { env, platform }) ?? command) : command;
  if (JS_EXT.test(resolved)) {
    const nodeBin = findLocalBinary(dirname(resolved), "node", platform) ?? findBinaryOnPath("node", { env, platform }) ?? "node";
    return { command: nodeBin, args: [resolved, ...args], shell: false, windowsHide: true };
  }
  if (WIN_SCRIPT_EXT.test(resolved)) {
    const script = unwrapCmdShim(resolved);
    if (script) {
      const nodeBin = findLocalBinary(dirname(resolved), "node", platform) ?? findBinaryOnPath("node", { env, platform });
      if (nodeBin) return { command: nodeBin, args: [script, ...args], shell: false, windowsHide: true };
    }
    return { command: resolved, args: [...args], shell: true, windowsHide: true };
  }
  return { command: resolved, args: [...args], shell: false, windowsHide: true };
}

/** Cross-platform `execFile` helper returning stdout (or `undefined` on any failure). */
export async function execCommand(
  file: string,
  args: readonly string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  try {
    const prepared = prepareSpawn(file, args, options.env);
    const { stdout } = await runExecFile(prepared.command, prepared.args, {
      timeout: options.timeout ?? 10_000,
      encoding: "utf8",
      shell: prepared.shell,
      windowsHide: prepared.windowsHide,
      ...(options.env ? { env: options.env } : {}),
    });
    return stdout;
  } catch {
    return undefined;
  }
}
