import { isAbsolute, relative, resolve } from "node:path";
import type { LinkedDir } from "@tide/contracts";

/** Tools whose input names a file the model intends to *change*. */
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Update"]);
/** Input keys Claude Code uses for the target file, in the order it prefers them. */
const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"];

/**
 * Containment against a normalised absolute root. `resolve` collapses `.`, `..` and
 * trailing slashes, so `/repo/`, `/repo/./x/..` and `/repo` all compare equal; a path that
 * only shares a *prefix* (`/repo-two`) is not contained.
 */
export function isUnder(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function targetPath(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Read-only links are the one thing Claude's own permission modes cannot express: the
 * directory has to be readable (so it is in `additionalDirectories`), which also makes it
 * writable. `canUseTool` is where Tide closes that gap.
 */
export function readOnlyLinkFor(toolName: string, input: Record<string, unknown>, links: LinkedDir[]): LinkedDir | undefined {
  if (!WRITE_TOOLS.has(toolName)) return undefined;
  const path = targetPath(input);
  if (path === undefined) return undefined;
  return links.find((link) => link.access === "read" && isUnder(link.path, path));
}

export const readOnlyDenyMessage = (link: LinkedDir): string =>
  `read-only linked repo: ${link.label} (${link.path}) is linked read-only; do not modify it.`;
