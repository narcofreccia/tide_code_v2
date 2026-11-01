import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Project, Thread } from "@tide/contracts";
import { Git } from "./git.ts";
import { provisionWorktree } from "./worktreeInclude.ts";

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

  /**
   * `startRef` (R4 fork): the new branch starts at that ref — a checkpoint of the source turn —
   * instead of the base branch's head, so the fork's files match what its history says. The
   * base branch (what the fork merges back into) is still the checkout's current branch.
   * The new worktree then gets the ignored files `.worktreeinclude` names (best-effort).
   */
  async create(project: Project, thread: Thread, startRef?: string): Promise<WorktreeInfo> {
    const info = await this.#withLock(project.rootPath, async () => {
      const root = this.#git(project.rootPath);
      if (!(await root.isRepo())) throw new Error(`${project.rootPath} is not a git repository`);
      const baseBranch = (await root.currentBranch()) ?? (await root.revParse("HEAD")) ?? "HEAD";
      if (startRef !== undefined && (await root.revParse(startRef)) === undefined) throw new Error(`fork point ${startRef} is gone`);

      const worktreePath = this.pathFor(project, thread);
      await mkdir(join(worktreePath, ".."), { recursive: true });

      const branch = await this.#freeBranch(root, thread);
      await root.worktreeAdd(worktreePath, branch, startRef ?? baseBranch);
      return { worktreePath, branch, baseBranch };
    });
    const { copied } = await provisionWorktree({ sourceRoot: project.rootPath, worktreePath: info.worktreePath, git: this.#git, log: this.#log });
    if (copied.length > 0) this.#log(`[vcs] copied ${copied.length} .worktreeinclude file(s) into ${info.worktreePath}`);
    return info;
  }

  /** `tide/<title slug>`, suffixed with the thread's short id when that name is taken. */
  async #freeBranch(root: Git, thread: Thread): Promise<string> {
    const base = `tide/${slugify(thread.title) || shortId(thread.id)}`;
    if ((await root.revParse(`refs/heads/${base}`)) === undefined) return base;
    return `${base}-${shortId(thread.id)}`;
  }

  async remove(project: Project, thread: Thread): Promise<void> {
    await this.removePath(project.rootPath, thread.worktreePath ?? this.pathFor(project, thread));
  }

  /** Same, from bare paths: `thread.deleted` has no thread left in the model to read them from. */
  async removePath(rootPath: string, worktreePath: string): Promise<void> {
    await this.#withLock(rootPath, async () => {
      const root = this.#git(rootPath);
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
