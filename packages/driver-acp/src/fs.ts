import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { LinkedDir } from "@tide/contracts";
import { rpcError } from "./jsonrpc.ts";
import { ACP_ERROR } from "./types.ts";

/**
 * The client side of ACP's `fs/read_text_file` / `fs/write_text_file`. The agent may only touch
 * the session's worktree and the thread's linked repositories; writes additionally need a
 * linked dir with `access: "write"`. Symlinks are resolved before the check, so a link inside
 * the worktree cannot reach outside it.
 */

/** realpath of the path, or of its nearest existing ancestor joined with the rest. */
function canonical(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // keep the resolved path
  }
  return rest.length > 0 ? resolve(real, ...rest) : real;
}

function inside(path: string, root: string): boolean {
  const rel = relative(canonical(root), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class FsPolicy {
  #cwd: string;
  #linked: LinkedDir[];

  constructor(cwd: string, linkedDirs: LinkedDir[] = []) {
    this.#cwd = cwd;
    this.#linked = linkedDirs;
  }

  /** The canonical path when `access` is allowed; throws an `invalid-params` JSON-RPC error otherwise. */
  check(path: unknown, access: "read" | "write"): string {
    if (typeof path !== "string" || !isAbsolute(path)) throw rpcError(ACP_ERROR.invalidParams, "path must be absolute");
    const target = canonical(path);
    if (inside(target, this.#cwd)) return target;
    const linked = this.#linked.find((dir) => inside(target, dir.path));
    if (linked && (access === "read" || linked.access === "write")) return target;
    const why = linked ? `linked repo ${linked.label} is read-only` : "outside the thread's worktree and linked repos";
    throw rpcError(ACP_ERROR.invalidParams, `Tide refused ${access} of ${path}: ${why}`);
  }

  async read(params: unknown): Promise<{ content: string }> {
    const { path, line, limit } = (params ?? {}) as { path?: unknown; line?: unknown; limit?: unknown };
    const target = this.check(path, "read");
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (error) {
      throw rpcError(ACP_ERROR.resourceNotFound, error instanceof Error ? error.message : String(error));
    }
    if (typeof line === "number" || typeof limit === "number") {
      const lines = content.split("\n");
      const start = typeof line === "number" && line > 0 ? line - 1 : 0;
      const end = typeof limit === "number" && limit >= 0 ? start + limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  async write(params: unknown): Promise<Record<string, never>> {
    const { path, content } = (params ?? {}) as { path?: unknown; content?: unknown };
    if (typeof content !== "string") throw rpcError(ACP_ERROR.invalidParams, "content must be a string");
    const target = this.check(path, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return {};
  }
}
