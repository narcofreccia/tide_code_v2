import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ReadModel } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";

export interface BrowseResult {
  path: string;
  parent?: string;
  home: string;
  isGitRepo: boolean;
  dirs: { name: string; path: string; isGitRepo: boolean }[];
  recent: string[];
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
): Promise<BrowseResult> {
  const requested = input.path && input.path.trim() !== "" ? input.path : home;
  if (!isAbsolute(requested)) throw new RpcException("invalid-params", "path must be absolute");
  const path = resolve(requested);
  if (!(await isDir(path))) throw new RpcException("not-found", `no such directory: ${path}`);

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
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    home,
    isGitRepo: await isGitRepo(path),
    dirs,
    recent,
  };
}
