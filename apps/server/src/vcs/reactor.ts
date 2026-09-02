import {
  newId as defaultNewId,
  type Activity,
  type EventRecord,
  type InternalCommand,
  type Project,
  type PullRequest,
  type ReadModel,
  type Thread,
  type Turn,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { SessionDirectory } from "../provider/sessions.ts";
import { threadCwd } from "../provider/sessions.ts";
import { CheckpointService } from "./checkpoints.ts";
import { Git } from "./git.ts";
import { Gh, type GhLike } from "./gh.ts";
import { WorktreeManager } from "./worktrees.ts";

export interface VcsReactorOptions {
  engine: Engine;
  worktrees: WorktreeManager;
  checkpoints: CheckpointService;
  /** closed when a worktree attaches, so the next turn opens the harness in the new cwd */
  sessions?: Pick<SessionDirectory, "close">;
  gh?: GhLike;
  git?: (cwd: string) => Git;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * Git side of the orchestration loop. Reacts to domain events with real git work and reports
 * the outcome back as internal commands — it decides nothing. Every repository operation for
 * one thread runs on that thread's own queue, and the engine listener never awaits any of it.
 */
export class VcsReactor {
  #engine: Engine;
  #worktrees: WorktreeManager;
  #checkpoints: CheckpointService;
  #sessions: Pick<SessionDirectory, "close"> | undefined;
  #gh: GhLike;
  #git: (cwd: string) => Git;
  #now: () => number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #queues = new Map<string, Promise<void>>();
  /** threadId -> why its worktree could not be created; surfaced on that thread's first turn */
  #worktreeFailures = new Map<string, string>();
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: VcsReactorOptions) {
    this.#engine = options.engine;
    this.#worktrees = options.worktrees;
    this.#checkpoints = options.checkpoints;
    this.#sessions = options.sessions;
    this.#gh = options.gh ?? new Gh();
    this.#git = options.git ?? ((cwd) => new Git(cwd));
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Resolves when the engine is drained and no git work is in flight. */
  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) {
        await this.#engine.drain();
        if (this.#inflight.size === 0) return;
        continue;
      }
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("vcs reactor did not drain");
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    switch (event.type) {
      case "thread.created":
        if (event.useWorktree === true) this.#enqueue(event.thread.id, () => this.#createWorktree(event.thread.id));
        return;
      case "turn.requested": {
        // Marked synchronously: the provider reactor's own listener runs right after this
        // one and must find a gate to wait on before it opens a session.
        this.#checkpoints.expect(event.turn.id);
        this.#enqueue(event.turn.threadId, () => this.#recordBefore(event.turn.threadId, event.turn.id));
        return;
      }
      case "turn.settled":
        this.#enqueue(event.threadId, () => this.#recordAfter(event.threadId, event.turnId));
        return;
      case "thread.archived":
        // archiving frees the disk unless the user asked to keep the checkout
        if (event.keepWorktree !== true) this.#enqueue(event.threadId, () => this.#detach(event.threadId, false));
        return;
      case "worktree.detach-requested": {
        const { threadId, deleteBranch } = event;
        this.#enqueue(threadId, () => this.#detach(threadId, deleteBranch === true));
        return;
      }
      case "worktree.attached":
        this.#track(this.#sessions?.close(event.threadId) ?? Promise.resolve());
        return;
      case "revert.requested":
        this.#enqueue(event.threadId, () => this.#revert(event.threadId, event.turnId));
        return;
      case "publish.requested": {
        const { threadId, title, body, commitOnly } = event;
        this.#enqueue(threadId, () => this.#publish(threadId, title, body, commitOnly === true));
        return;
      }
      default:
        return;
    }
  }

  // ---- plumbing ----

  #track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  #enqueue(threadId: string, task: () => Promise<void>): void {
    const queue = (this.#queues.get(threadId) ?? Promise.resolve())
      .then(task)
      .catch((err: unknown) => this.#log("[vcs] task failed", err));
    this.#queues.set(threadId, queue);
    this.#track(queue);
  }

  async #dispatch(command: InternalCommand): Promise<void> {
    try {
      await this.#engine.dispatch(command);
    } catch (err) {
      this.#log(`[vcs] ${command.type} rejected`, err);
    }
  }


  #context(threadId: string): { model: ReadModel; thread: Thread; project: Project; cwd: string } | undefined {
    const model = this.#engine.getModel();
    const thread = model.threads[threadId];
    const project = thread ? model.projects[thread.projectId] : undefined;
    if (!thread || !project) return undefined;
    return { model, thread, project, cwd: threadCwd(thread, project) };
  }

  #turnsOf(model: ReadModel, threadId: string): Turn[] {
    return Object.values(model.turns)
      .filter((t) => t.threadId === threadId)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  async #info(threadId: string, kind: "info" | "error", text: string): Promise<void> {
    const model = this.#engine.getModel();
    const turnId = model.threads[threadId]?.latestTurnId;
    if (turnId === undefined) {
      this.#log(`[vcs] ${kind}: ${text}`, threadId);
      return;
    }
    await this.#post(threadId, turnId, kind, text);
  }

  /** Same, but on a turn the caller already holds (the before-checkpoint path). */
  async #post(threadId: string, turnId: string, kind: "info" | "error", text: string): Promise<void> {
    const at = this.#now();
    const activity: Activity = { id: this.#newId(), threadId, turnId, kind, text, createdAt: at, updatedAt: at };
    await this.#dispatch({ type: "activity.upsert", activity });
  }

  // ---- handlers ----

  /**
   * Worktree creation happens before the thread has a turn, so a failure is remembered here and
   * reported as an error activity on the thread's first turn (see `#recordBefore`): the thread
   * silently falling back to the project's main checkout is exactly what the user must know.
   */
  async #createWorktree(threadId: string): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    try {
      const info = await this.#worktrees.create(ctx.project, ctx.thread);
      await this.#dispatch({
        type: "worktree.attach",
        threadId,
        worktreePath: info.worktreePath,
        branch: info.branch,
        baseBranch: info.baseBranch,
      });
    } catch (err) {
      this.#worktreeFailures.set(threadId, message(err));
      this.#log("[vcs] worktree creation failed; thread stays on the project root", err);
    }
  }

  /** Reports a remembered worktree failure once, on the first turn that follows it. */
  async #reportWorktreeFailure(threadId: string, turnId: string): Promise<void> {
    const reason = this.#worktreeFailures.get(threadId);
    if (reason === undefined) return;
    this.#worktreeFailures.delete(threadId);
    await this.#post(
      threadId,
      turnId,
      "error",
      `Worktree could not be created (${reason}); this thread runs in the project's main checkout — revert and publish are disabled.`,
    );
  }

  /**
   * Tears a thread's worktree down: closes the harness session holding the cwd open, parks any
   * uncommitted work on a ref so archiving can never lose it, removes the checkout (the branch
   * survives) and records the fact through the server-internal command path. `deleteBranch` is
   * honoured only for Tide-owned `tide/*` branches — anything else is refused and logged.
   */
  async #detach(threadId: string, deleteBranch: boolean): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx || ctx.thread.worktreePath === undefined) return;
    const worktreePath = ctx.thread.worktreePath;
    try {
      await this.#sessions?.close(threadId);
      await this.#preserve(threadId, worktreePath);
      await this.#worktrees.remove(ctx.project, ctx.thread);
      if (deleteBranch) await this.#deleteBranch(ctx.project.rootPath, ctx.thread.branch);
      await this.#dispatch({ type: "worktree.detached", threadId });
    } catch (err) {
      this.#log("[vcs] worktree detach failed", err);
    }
  }

  /** Uncommitted work in a worktree about to be deleted is parked on `refs/tide/archived/<threadId>`. */
  async #preserve(threadId: string, worktreePath: string): Promise<void> {
    const git = this.#git(worktreePath);
    if (!(await git.isRepo())) return;
    if ((await git.status()).dirty === 0) return;
    const sha = await git.snapshot(`tide: archived worktree ${threadId}`);
    await git.updateRef(`refs/tide/archived/${threadId}`, sha);
    this.#log(`[vcs] uncommitted work preserved at refs/tide/archived/${threadId}`, sha);
  }

  async #deleteBranch(rootPath: string, branch: string | undefined): Promise<void> {
    if (branch === undefined) return;
    if (!branch.startsWith("tide/")) {
      this.#log(`[vcs] refusing to delete ${branch}: only tide/* branches are Tide's to remove`);
      return;
    }
    if (!(await this.#git(rootPath).deleteBranch(branch))) this.#log(`[vcs] could not delete branch ${branch}`);
  }

  async #recordBefore(threadId: string, turnId: string): Promise<void> {
    await this.#reportWorktreeFailure(threadId, turnId);
    const ctx = this.#context(threadId);
    if (!ctx || !(await this.#git(ctx.cwd).isRepo())) {
      this.#checkpoints.release(turnId);
      return;
    }
    try {
      const { ref } = await this.#checkpoints.recordBefore(ctx.cwd, threadId, turnId);
      await this.#dispatch({ type: "checkpoint.record", turnId, phase: "before", ref });
    } catch (err) {
      this.#checkpoints.release(turnId);
      this.#log("[vcs] before-checkpoint failed", err);
    }
  }

  async #recordAfter(threadId: string, turnId: string): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    if (ctx.model.turns[turnId]?.checkpoint?.before === undefined) return; // nothing was snapshotted
    try {
      const { ref, stats } = await this.#checkpoints.recordAfter(ctx.cwd, threadId, turnId);
      await this.#dispatch({
        type: "checkpoint.record",
        turnId,
        phase: "after",
        ref,
        ...(stats !== undefined ? { stats } : {}),
      });
    } catch (err) {
      this.#log("[vcs] after-checkpoint failed", err);
    }
  }

  async #revert(threadId: string, turnId: string): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    const turns = this.#turnsOf(ctx.model, threadId);
    const index = turns.findIndex((t) => t.id === turnId);
    const before = ctx.model.turns[turnId]?.checkpoint?.before;
    if (before === undefined) {
      await this.#info(threadId, "error", "Revert failed: this turn has no checkpoint");
      return;
    }
    try {
      await this.#checkpoints.revertTo(ctx.cwd, before);
      await this.#info(threadId, "info", `Reverted to before turn ${index >= 0 ? index + 1 : "?"}`);
    } catch (err) {
      await this.#info(threadId, "error", `Revert failed: ${message(err)}`);
    }
  }

  async #publish(threadId: string, title: string | undefined, body: string | undefined, commitOnly: boolean): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    const git = this.#git(ctx.cwd);
    const commitMessage = title ?? `tide: ${ctx.thread.title}`;
    try {
      if (!(await git.isRepo())) {
        await this.#info(threadId, "error", `Publish failed: ${ctx.cwd} is not a git repository`);
        return;
      }
      const sha = await git.commitAll(commitMessage);
      if (commitOnly) {
        await this.#info(threadId, "info", sha === undefined ? "Nothing to commit" : `Committed ${sha.slice(0, 8)}`);
        return;
      }
      const branch = ctx.thread.branch ?? (await git.currentBranch());
      if (branch === undefined) {
        await this.#info(threadId, "error", "Publish failed: detached HEAD has no branch to push");
        return;
      }
      if (!(await git.hasRemote())) {
        await this.#info(threadId, "info", `Committed on ${branch}; no remote configured, nothing pushed`);
        return;
      }
      await git.push(branch);
      await this.#openOrUpdatePr(threadId, ctx.cwd, ctx.thread, branch, commitMessage, body);
    } catch (err) {
      await this.#info(threadId, "error", `Publish failed: ${message(err)}`);
    }
  }

  async #openOrUpdatePr(
    threadId: string,
    cwd: string,
    thread: Thread,
    branch: string,
    title: string,
    body: string | undefined,
  ): Promise<void> {
    if (!(await this.#gh.hasGh())) {
      await this.#info(threadId, "info", `Pushed ${branch}; install the GitHub CLI to open a pull request`);
      return;
    }
    const existing = await this.#gh.prView(cwd, branch);
    const pr: PullRequest = existing
      ? { ...existing, updatedAt: this.#now() }
      : {
          ...(await this.#gh.prCreate(cwd, {
            title,
            ...(body !== undefined ? { body } : {}),
            ...(thread.baseBranch !== undefined ? { base: thread.baseBranch } : {}),
            head: branch,
          })),
          state: "open",
          updatedAt: this.#now(),
        };
    await this.#dispatch({ type: "pr.update", threadId, pr });
    await this.#info(threadId, "info", `${existing ? "Updated" : "Opened"} pull request #${pr.number}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
