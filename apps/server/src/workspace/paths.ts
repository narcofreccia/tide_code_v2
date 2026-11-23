import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RpcException } from "../rpc/router.ts";

/** The `node:path` flavour a pure helper uses; tests pass `win32` to exercise Windows semantics on any host. */
export type PathModule = Pick<typeof nodePath, "relative" | "resolve" | "isAbsolute" | "sep">;

/**
 * A relative path with `/` separators, the form git prints and the client uses. On Windows
 * `path.relative` returns `src\a.ts`, which git refuses in `<rev>:<path>`, never equals a path from
 * `git status`, and slips past `/`-based checks such as `isGitInternal`. A no-op on POSIX.
 */
export function toPosixRel(rel: string, path: PathModule = nodePath): string {
  return path.sep === "/" ? rel : rel.split(path.sep).join("/");
}

export interface InsideOptions {
  /** allow the cwd itself (used by `fs.list` with no path) */
  allowRoot?: boolean;
}

export interface ResolvedPath {
  /** lexically resolved absolute path (what fs calls should use) */
  abs: string;
  /** cwd-relative path with `/` separators on every platform */
  rel: string;
}

const escapes = (input: string): never => {
  throw new RpcException("invalid-params", `path ${input} escapes the thread's working directory`);
};

/**
 * Lexical containment check: rejects `..` escapes and absolute paths outside `cwd`.
 * Returns the cwd-relative path with `/` separators. This is the single implementation shared
 * by the vcs handlers (as `safeRelativePath`) and the workspace services.
 */
export function safeRelativePath(cwd: string, input: string, options: InsideOptions = {}, path: PathModule = nodePath): string {
  const rel = path.relative(cwd, path.resolve(cwd, input));
  if (rel.startsWith("..") || path.isAbsolute(rel)) escapes(input);
  if (rel === "" && options.allowRoot !== true) escapes(input);
  return toPosixRel(rel, path);
}

/** realpath of the deepest existing ancestor of `p`, with the missing tail re-appended. */
async function realpathDeepest(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return tail.length === 0 ? await realpath(cur) : join(await realpath(cur), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Lexical check plus a realpath check, so a symlink inside the cwd that points outside
 * it is rejected too. The returned `abs` is the lexical path: fs operations should act on
 * the name the caller asked for, not on the resolved target.
 */
export async function resolveInside(cwd: string, input: string, options: InsideOptions = {}): Promise<ResolvedPath> {
  const rel = safeRelativePath(cwd, input, options);
  const abs = resolve(cwd, rel);
  let rootReal: string;
  try {
    rootReal = await realpath(cwd);
  } catch {
    throw new RpcException("not-found", `working directory ${cwd} does not exist`);
  }
  const targetReal = await realpathDeepest(abs);
  const realRel = relative(rootReal, targetReal);
  if (realRel.startsWith("..") || isAbsolute(realRel)) escapes(input);
  if (realRel === "" && options.allowRoot !== true) escapes(input);
  return { abs, rel };
}
