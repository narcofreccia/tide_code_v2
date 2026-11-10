import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Project, ReadModel, Thread } from "@tide/contracts";
import { Git } from "./git.ts";
import { provisionWorktree } from "./worktreeInclude.ts";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  /** set when `startRef` was gone and the branch started at the caller's `fallbackRef` instead */
  fellBackTo?: string;
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

/** The project root is no git repository: there is no worktree to create, by nature, not by failure. */
export class NotARepositoryError extends Error {
  constructor(rootPath: string) {
    super(`${rootPath} is not a git repository`);
    this.name = "NotARepositoryError";
  }
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
    return join(this.projectDir(project), shortId(thread.id));
  }

  /** `<TIDE_HOME>/worktrees/<projectSlug>`: every thread worktree of `project` lives directly under it. */
  projectDir(project: Project): string {
    const projectSlug = `${slugify(project.title) || slugify(basename(project.rootPath)) || "project"}-${project.id.slice(-6).toLowerCase()}`;
    return join(this.#root, projectSlug);
  }

  /** Re-provisions `.worktreeinclude` files into an adopted worktree (copies only what is missing). */
  async provision(project: Project, worktreePath: string): Promise<void> {
    await provisionWorktree({ sourceRoot: project.rootPath, worktreePath, git: this.#git, log: this.#log });
  }

  /** `git worktree prune` on the project's lock (B2 boot recovery); throws on a git failure. */
  async prune(rootPath: string): Promise<void> {
    await this.#withLock(rootPath, async () => void (await this.#git(rootPath).run(["worktree", "prune"])));
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
   * When `startRef` no longer resolves (merge-back deleted the source's checkpoint refs) the
   * branch starts at `fallbackRef` when given and present, reported as `fellBackTo`; otherwise
   * creation fails. The new worktree then gets the ignored files `.worktreeinclude` names (best-effort).
   */
  async create(project: Project, thread: Thread, startRef?: string, options: { fallbackRef?: string } = {}): Promise<WorktreeInfo> {
    const info = await this.#withLock(project.rootPath, async () => {
      const root = this.#git(project.rootPath);
      if (!(await root.isRepo())) throw new NotARepositoryError(project.rootPath);
      const baseBranch = (await root.currentBranch()) ?? (await root.revParse("HEAD")) ?? "HEAD";
      let start = startRef;
      let fellBackTo: string | undefined;
      if (startRef !== undefined && (await root.revParse(startRef)) === undefined) {
        const { fallbackRef } = options;
        if (fallbackRef === undefined || (await root.revParse(fallbackRef)) === undefined) throw new Error(`fork point ${startRef} is gone`);
        start = fallbackRef;
        fellBackTo = fallbackRef;
      }

      const worktreePath = this.pathFor(project, thread);
      await mkdir(join(worktreePath, ".."), { recursive: true });

      const branch = await this.#freeBranch(root, thread);
      await root.worktreeAdd(worktreePath, branch, start ?? baseBranch);
      return { worktreePath, branch, baseBranch, ...(fellBackTo !== undefined ? { fellBackTo } : {}) };
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

/**
 * The base branch a fork's source thread was merged back into, when it was: the head of that
 * branch holds the source's work once its own branch and checkpoint refs are gone.
 */
export function mergedSourceBase(model: ReadModel, thread: Thread): string | undefined {
  const sourceId = thread.forkedFrom?.threadId;
  const source = sourceId === undefined ? undefined : model.threads[sourceId];
  if (source === undefined || source.baseBranch === undefined) return undefined;
  const merged = source.merge?.status === "merged" || source.mergedAt !== undefined;
  return merged ? source.baseBranch : undefined;
}

/** Starts with WORKTREE_FAILURE_PREFIX, like the refusal below. */
export function notARepoText(reason: string): string {
  return `Worktree could not be created (${reason}); this thread runs in the project's folder — checkpoints, file restore and publish are disabled.`;
}

/** Starts with WORKTREE_FAILURE_PREFIX (recovery.ts looks for it before warning a second time). */
export function worktreeFailureText(reason: string): string {
  return `Worktree could not be created (${reason}). This thread asked for its own worktree, so it will not run in the project's main checkout: fork it or start a new thread.`;
}
