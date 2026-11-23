import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import type { ReadModel } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";

export interface BrowseResult {
  path: string;
  parent?: string;
  home: string;
  isGitRepo: boolean;
  dirs: { name: string; path: string; isGitRepo: boolean }[];
  recent: string[];
  /** every drive root on a host that has several (Windows); absent elsewhere */
  roots?: string[];
}

/** How the picker finds the host's filesystem roots; injectable so tests can play Windows. */
export interface RootsHost {
  platform?: NodeJS.Platform;
  /** resolves true when `root` exists; may never settle (a disconnected network drive) */
  probe?: (root: string) => Promise<boolean>;
  /** per-probe budget; a probe that has not answered by then counts as absent */
  timeoutMs?: number;
}

const ROOT_PROBE_TIMEOUT_MS = 400;
const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function withTimeout(probe: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const timer = setTimeout(() => resolveProbe(false), timeoutMs);
    timer.unref?.();
    probe.then(
      (ok) => {
        clearTimeout(timer);
        resolveProbe(ok);
      },
      () => {
        clearTimeout(timer);
        resolveProbe(false);
      },
    );
  });
}

/**
 * The drive roots (`C:\`, `D:\`, …) of a Windows host, probed concurrently, each bounded by
 * `timeoutMs`, so the whole call answers within about one budget even when a mapped network
 * drive or an empty card reader never does. The drive of `current` is always listed. Undefined
 * on other platforms, where `/` is the only root.
 */
export async function listRoots(current: string, host: RootsHost = {}): Promise<string[] | undefined> {
  if ((host.platform ?? process.platform) !== "win32") return undefined;
  const probe = host.probe ?? isDir;
  const timeoutMs = host.timeoutMs ?? ROOT_PROBE_TIMEOUT_MS;
  const candidates = [...DRIVE_LETTERS].map((letter) => `${letter}:\\`);
  const present = await Promise.all(candidates.map((root) => withTimeout(probe(root), timeoutMs)));
  const roots = candidates.filter((_, i) => present[i]);
  const own = win32.parse(current).root.replace(/^[a-z]:/, (d) => d.toUpperCase());
  if (own !== "" && !roots.some((r) => r.toLowerCase() === own.toLowerCase())) roots.push(own);
  return roots.sort((a, b) => a.localeCompare(b));
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A directory is a repo root when it contains `.git` (dir or worktree file). */
async function isGitRepo(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Windows folders that are system plumbing, never a project: `$Recycle.Bin`, `$WinREAgent`, … */
const WINDOWS_SYSTEM_DIRS = new Set(["system volume information", "config.msi", "recovery", "msocache"]);

/**
 * Whether the picker lists a folder by default. Dot-folders are hidden everywhere; on Windows,
 * where hiding is a file attribute `readdir` does not report, the drive-root system folders too.
 */
export function isListedByDefault(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (name.startsWith(".")) return false;
  if (platform !== "win32") return true;
  return !name.startsWith("$") && !WINDOWS_SYSTEM_DIRS.has(name.toLowerCase());
}

/**
 * Directory browser for the project picker. Lists subdirectories of an absolute path on
 * the server host (defaults to the home dir), flags git repositories, and returns the
 * roots of existing projects as "recent". Files are never listed; hidden dirs only on
 * request.
 */
export async function browseDirectories(
  model: ReadModel,
  input: { path?: string; showHidden?: boolean },
  home: string = homedir(),
  host: RootsHost = {},
): Promise<BrowseResult> {
  const requested = input.path && input.path.trim() !== "" ? input.path : home;
  if (!isAbsolute(requested)) throw new RpcException("invalid-params", "path must be absolute");
  const path = resolve(requested);
  if (!(await isDir(path))) throw new RpcException("not-found", `no such directory: ${path}`);

  const rootsProbe = listRoots(path, host); // concurrent with the listing below
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && (input.showHidden || isListedByDefault(e.name)) && e.name !== ".git")
      .map(async (e) => {
        const full = join(path, e.name);
        return { name: e.name, path: full, isGitRepo: await isGitRepo(full) };
      }),
  );
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const recent = Object.values(model.projects)
    .filter((p) => p.archivedAt === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => p.rootPath)
    .slice(0, 8);

  const parent = dirname(path);
  const roots = await rootsProbe;
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    home,
    isGitRepo: await isGitRepo(path),
    dirs,
    recent,
    ...(roots !== undefined ? { roots } : {}),
  };
}
