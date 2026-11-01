import { chmod, constants, copyFile, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { Git } from "./git.ts";

/** Claude Code's convention: gitignore-syntax patterns at the repo root naming ignored files every worktree needs. */
export const WORKTREE_INCLUDE = ".worktreeinclude";
const CONCURRENCY = 8;

export interface ProvisionOptions {
  /** the checkout the files come from (the project root) */
  sourceRoot: string;
  worktreePath: string;
  git?: (cwd: string) => Git;
  log?: (msg: string, data?: unknown) => void;
}

export interface ProvisionResult {
  copied: string[];
  /** already present in the worktree, unsafe, or failed to copy (logged) */
  skipped: string[];
}

const exists = (path: string): Promise<boolean> => lstat(path).then(
  () => true,
  () => false,
);

const splitZ = (out: string): string[] => out.split("\0").filter((p) => p.length > 0);

/** A repo-relative path that stays inside the checkout. */
const safeRelative = (path: string): boolean => {
  if (isAbsolute(path)) return false;
  const norm = normalize(path);
  return norm !== ".." && !norm.startsWith(`..${sep}`) && !norm.split(sep).includes("..");
};

/**
 * Copies the files a fresh worktree lacks but the build needs (sidecar binaries, `.env`): every
 * untracked file in `sourceRoot` that matches `.worktreeinclude` and is also gitignored. The
 * main checkout's `.worktreeinclude` wins; a committed one in the worktree is the fallback.
 * Existing destinations are never overwritten, so calling it again only fills gaps. Copies are
 * copy-on-write clones where the filesystem supports it. Never throws: errors are logged.
 */
export async function provisionWorktree(options: ProvisionOptions): Promise<ProvisionResult> {
  const result: ProvisionResult = { copied: [], skipped: [] };
  const log = options.log ?? (() => undefined);
  const { sourceRoot, worktreePath } = options;
  try {
    let patterns = join(sourceRoot, WORKTREE_INCLUDE);
    if (!(await exists(patterns))) patterns = join(worktreePath, WORKTREE_INCLUDE);
    if (!(await exists(patterns))) return result;

    const git = (options.git ?? ((cwd) => new Git(cwd)))(sourceRoot);
    const listed = await git.tryRun(["ls-files", "--others", "--ignored", `--exclude-from=${patterns}`, "-z"]);
    if (listed.code !== 0) {
      log("[vcs] .worktreeinclude: listing failed", listed.stderr.trim());
      return result;
    }
    const candidates = splitZ(listed.stdout);
    if (candidates.length === 0) return result;
    // only gitignored files: an untracked, unignored file is the user's work in progress
    const ignored = await git.tryRunWithInput(["check-ignore", "--stdin", "-z"], `${candidates.join("\0")}\0`);
    const paths = ignored.code === 0 ? splitZ(ignored.stdout) : [];

    const queue = [...paths];
    const worker = async (): Promise<void> => {
      for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
        const outcome = await copyOne(sourceRoot, worktreePath, rel).catch((err: unknown) => {
          log(`[vcs] .worktreeinclude: copying ${rel} failed`, err);
          return false;
        });
        (outcome ? result.copied : result.skipped).push(rel);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  } catch (err) {
    log("[vcs] .worktreeinclude: provisioning failed", err);
  }
  result.copied.sort();
  result.skipped.sort();
  return result;
}

/** true when copied; false when skipped (unsafe path or the destination exists). */
async function copyOne(sourceRoot: string, worktreePath: string, rel: string): Promise<boolean> {
  if (!safeRelative(rel)) return false;
  const src = join(sourceRoot, rel);
  const dst = join(worktreePath, rel);
  if (await exists(dst)) return false;
  await mkdir(dirname(dst), { recursive: true });
  const info = await lstat(src);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(src), dst);
    return true;
  }
  if (!info.isFile()) return false;
  await copyFile(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  if (((await lstat(dst)).mode & 0o7777) !== (info.mode & 0o7777)) await chmod(dst, info.mode & 0o7777);
  return true;
}
