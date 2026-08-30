import { Git } from "../vcs/git.ts";

/** `.git` internals are never listed, watched or searched. */
export const isGitInternal = (rel: string): boolean => rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/");

export type GitFactory = (cwd: string) => Git;

const defaultGit: GitFactory = (cwd) => new Git(cwd);

/**
 * Batched `git check-ignore --stdin -z`. One process per call, not one per path.
 * Returns the subset of `paths` (cwd-relative) that git ignores; an empty set when the
 * cwd is not a repository.
 */
export async function checkIgnore(cwd: string, paths: string[], git: GitFactory = defaultGit): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (paths.length === 0) return ignored;
  const repo = git(cwd);
  // `--no-index` is deliberately omitted: tracked files are never "ignored".
  const run = await repo.tryRunWithInput(["check-ignore", "--stdin", "-z"], paths.join("\0"));
  // 0 = some paths ignored, 1 = none, 128 = not a repo / bad usage.
  if (run.code !== 0) return ignored;
  for (const line of run.stdout.split("\0")) if (line !== "") ignored.add(line);
  return ignored;
}

/**
 * check-ignore results cached per cwd. The cache is dropped whenever a `.gitignore`
 * (or `.git/info/exclude`) changes, which is what the watcher feeds in.
 */
export class IgnoreCache {
  #cwd: string;
  #git: GitFactory;
  #cache = new Map<string, boolean>();
  #enabled: boolean | undefined;

  constructor(cwd: string, git: GitFactory = defaultGit) {
    this.#cwd = cwd;
    this.#git = git;
  }

  invalidate(): void {
    this.#cache.clear();
  }

  static affectsIgnores(rel: string): boolean {
    return rel === ".gitignore" || rel.endsWith("/.gitignore") || rel.endsWith(".git/info/exclude");
  }

  /** Resolves each path to its ignored flag, consulting git only for unknown ones. */
  async resolve(paths: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const unknown: string[] = [];
    for (const p of paths) {
      const cached = this.#cache.get(p);
      if (cached === undefined) unknown.push(p);
      else out.set(p, cached);
    }
    if (unknown.length > 0) {
      if (this.#enabled === undefined) this.#enabled = await this.#git(this.#cwd).isRepo();
      const ignored = this.#enabled ? await checkIgnore(this.#cwd, unknown, this.#git) : new Set<string>();
      for (const p of unknown) {
        const flag = ignored.has(p);
        this.#cache.set(p, flag);
        out.set(p, flag);
      }
    }
    return out;
  }

  async isIgnored(path: string): Promise<boolean> {
    return (await this.resolve([path])).get(path) === true;
  }
}
