import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RpcException } from "../rpc/router.ts";

export interface InsideOptions {
  /** allow the cwd itself (used by `fs.list` with no path) */
  allowRoot?: boolean;
}

export interface ResolvedPath {
  /** lexically resolved absolute path (what fs calls should use) */
  abs: string;
  /** cwd-relative path, POSIX-ish separators as produced by node:path */
  rel: string;
}

const escapes = (input: string): never => {
  throw new RpcException("invalid-params", `path ${input} escapes the thread's working directory`);
};

/**
 * Lexical containment check: rejects `..` escapes and absolute paths outside `cwd`.
 * Returns the cwd-relative path. This is the single implementation shared by the vcs
 * handlers (as `safeRelativePath`) and the workspace services.
 */
export function safeRelativePath(cwd: string, input: string, options: InsideOptions = {}): string {
  const rel = relative(cwd, resolve(cwd, input));
  if (rel.startsWith("..") || isAbsolute(rel)) escapes(input);
  if (rel === "" && options.allowRoot !== true) escapes(input);
  return rel;
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
