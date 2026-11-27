import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { windowsFolderNameProblem } from "../hostPath.ts";
import { isInside } from "../rpc/projectEnsure.ts";

const DEFAULT_ROOT = join(homedir(), "dev", "projects");
export const PROJECT_NAME_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$";
const PROJECT_NAME = new RegExp(PROJECT_NAME_PATTERN);

export function projectRoots(configured = process.env.TIDE_MCP_ALLOWED_ROOTS): readonly string[] {
  return configured === undefined ? [DEFAULT_ROOT] : configured.split(",").map((root) => root.trim()).filter(Boolean);
}

/** Each configured root is a boundary. Explicit parents must resolve to a boundary or a child of one. */
export function createProjectDirectory(roots: readonly string[], name: string, requested?: string, gitInit = true): string {
  if (!PROJECT_NAME.test(name) || name.includes("..")) throw new Error("Invalid project name");
  const windowsProblem = windowsFolderNameProblem(name);
  if (windowsProblem !== undefined) throw new Error(`Project name ${windowsProblem}`);
  if (requested !== undefined && (!isAbsolute(requested) || requested.split(/[/\\]/).includes(".."))) {
    throw new Error("Project root must be an absolute path without traversal");
  }
  const allowed = roots.flatMap((root) => {
    try {
      const path = resolve(root);
      const canonical = realpathSync(path);
      return statSync(canonical).isDirectory() ? [{ path, canonical }] : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  });
  const defaultParent = roots[0];
  if (!defaultParent) throw new Error("No MCP project roots are configured");
  const parent = resolve(requested ?? defaultParent);
  let canonical: string;
  try {
    canonical = realpathSync(parent);
  } catch {
    throw new Error("Project root does not exist");
  }
  const within = (root: string, path: string) => root === path || isInside(root, path);
  if (!allowed.some((root) => within(root.canonical, canonical) && (within(root.path, parent) || within(root.canonical, parent)))) {
    throw new Error("Project root is outside the allowed MCP roots");
  }

  const target = join(canonical, name);
  // Non-recursive mkdir refuses existing paths, including dangling symlinks.
  mkdirSync(target, { recursive: false });
  const actual = realpathSync(target);
  if (actual !== target || !isInside(canonical, actual) || realpathSync(canonical) !== canonical) {
    throw new Error("Project directory escaped its allowed root");
  }
  try {
    if (gitInit) execFileSync("git", ["init"], { cwd: actual, stdio: "ignore", timeout: 10_000 });
    return actual;
  } catch (err) {
    rmSync(actual, { recursive: true, force: true });
    throw err;
  }
}
