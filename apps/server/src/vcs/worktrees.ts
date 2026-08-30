import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Project, Thread } from "@tide/contracts";
import { Git } from "./git.ts";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface WorktreeManagerOptions {
  /** TIDE_HOME; worktrees live under `<tideHome>/worktrees` */
  tideHome: string;
  git?: (cwd: string) => Git;
  log?: (msg: string, data?: unknown) => void;
}

/** `Some Title!` -> `some-title`; empty input yields "". */
export function slugify(input: string, max = 40): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const shortId = (id: string): string => id.slice(-8).toLowerCase();

/**
 * Owns `<TIDE_HOME>/worktrees/<projectSlug>/<threadIdShort>`, one git worktree per thread
 * on branch `tide/<slug of the thread title>`, forked from whatever branch the project root
 * is on at creation time. `git worktree add` mutates shared repo state, so every operation
 * on one repository is serialized through a per-project lock.
 */
export class WorktreeManager {
  #root: string;
  #git: (cwd: string) => Git;
  #log: (msg: string, data?: unknown) => void;
  #locks = new Map<string, Promise<unknown>>();

  constructor(options: WorktreeManagerOptions) {
    this.#root = join(options.tideHome, "worktrees");
    this.#git = options.git ?? ((cwd) => new Git(cwd));
    this.#log = options.log ?? (() => undefined);
  }

  get root(): string {
    return this.#root;
  }

  pathFor(project: Project, thread: Thread): string {
    const projectSlug = `${slugify(project.title) || slugify(basename(project.rootPath)) || "project"}-${project.id.slice(-6).toLowerCase()}`;
    return join(this.#root, projectSlug, shortId(thread.id));
  }

  /** Serializes everything touching one repository (`git worktree add` is not concurrency-safe). */
  #withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async create(project: Project, thread: Thread): Promise<WorktreeInfo> {
    return this.#withLock(project.rootPath, async () => {
      const root = this.#git(project.rootPath);
      if (!(await root.isRepo())) throw new Error(`${project.rootPath} is not a git repository`);
      const baseBranch = (await root.currentBranch()) ?? (await root.revParse("HEAD")) ?? "HEAD";

      const worktreePath = this.pathFor(project, thread);
      await mkdir(join(worktreePath, ".."), { recursive: true });

      const branch = await this.#freeBranch(root, thread);
      await root.worktreeAdd(worktreePath, branch, baseBranch);
      return { worktreePath, branch, baseBranch };
    });
  }

  /** `tide/<title slug>`, suffixed with the thread's short id when that name is taken. */
  async #freeBranch(root: Git, thread: Thread): Promise<string> {
    const base = `tide/${slugify(thread.title) || shortId(thread.id)}`;
    if ((await root.revParse(`refs/heads/${base}`)) === undefined) return base;
    return `${base}-${shortId(thread.id)}`;
  }

  async remove(project: Project, thread: Thread): Promise<void> {
    const worktreePath = thread.worktreePath ?? this.pathFor(project, thread);
    await this.#withLock(project.rootPath, async () => {
      const root = this.#git(project.rootPath);
      try {
        await root.worktreeRemove(worktreePath, true);
      } catch (err) {
        this.#log("[vcs] worktree remove failed; pruning", err);
        await rm(worktreePath, { recursive: true, force: true });
        await root.tryRun(["worktree", "prune"]);
      }
    });
  }
}
