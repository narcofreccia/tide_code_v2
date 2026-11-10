import { existsSync } from "node:fs";
import {
  newId as defaultNewId,
  type Activity,
  type EventOf,
  type EventRecord,
  type GitSettings,
  type InternalCommand,
  type MergeStrategy,
  type Project,
  type PullRequest,
  type ReadModel,
  type Thread,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { SessionDirectory } from "../provider/sessions.ts";
import type { OneShotDeps } from "../rpc/oneShot.ts";
import type { SettingsStore } from "../settings.ts";
import { threadCwd } from "../provider/sessions.ts";
import { CheckpointService } from "./checkpoints.ts";
import { Git } from "./git.ts";
import { Gh, type GhLike } from "./gh.ts";
import { MergeBack } from "./merge.ts";
import { formatCommitMessage, generateCommitMessage } from "./messages.ts";
import { hasOrigin, pushBase, pushThreadBranch, syncBase } from "./remoteSync.ts";
import { sharingThread } from "./restore.ts";
import { recoverVcs, type IntentJournal, type VcsRecoveryOptions, type VcsRecoveryReport } from "./recovery.ts";
import { WorktreeManager } from "./worktrees.ts";

export interface VcsReactorOptions {
  engine: Engine;
  worktrees: WorktreeManager;
  checkpoints: CheckpointService;
  /** closed when a worktree attaches, so the next turn opens the harness in the new cwd */
  sessions?: Pick<SessionDirectory, "close">;
  gh?: GhLike;
  git?: (cwd: string) => Git;
  /** merge-back runner; built from `tideHome` + `gh` when omitted */
  merge?: MergeBack;
  /** called right before a worktree directory is removed (terminals and watchers holding it go first) */
  onDetach?: (threadId: string, worktreePath: string) => void;
  /** a publish opened/updated the thread's PR or a merge landed: the PR watcher refreshes it */
  onPrChange?: (threadId: string) => void;
  /** R17/R18: `git.pushThreadBranches` / `syncBaseWithRemote` / `pushBaseAfterMerge` / `generateMessages`, read at event time; absent = all off */
  settings?: Pick<SettingsStore, "get">;
  /** R17 C5: harnesses for generated commit / PR text (`settings.git.generateMessages`) */
  oneShot?: OneShotDeps;
  /** B1: publish / detach intents in flight, persisted so the next boot knows which ones a crash cut short */
  journal?: IntentJournal;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string, data?: unknown) => void;
}

type ReactorGitSettings = Pick<GitSettings, "pushThreadBranches" | "syncBaseWithRemote" | "pushBaseAfterMerge" | "generateMessages">;

const GIT_OFF: ReactorGitSettings = {
  pushThreadBranches: "never",
  syncBaseWithRemote: false,
  pushBaseAfterMerge: false,
  generateMessages: false,
};

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
  #merge: MergeBack;
  #onDetach: ((threadId: string, worktreePath: string) => void) | undefined;
  #onPrChange: ((threadId: string) => void) | undefined;
  #settings: Pick<SettingsStore, "get"> | undefined;
  #oneShot: OneShotDeps | undefined;
  #journal: IntentJournal | undefined;
  /** threads whose last branch push failed: one activity per failure streak */
  #pushMuted = new Set<string>();
  #now: () => number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #queues = new Map<string, Promise<void>>();
  /** tail of the `thread.deleted` chain (see `#oneDeletionAtATime`) */
  #deletions: Promise<void> = Promise.resolve();
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
    this.#onDetach = options.onDetach;
    this.#onPrChange = options.onPrChange;
    this.#settings = options.settings;
    this.#oneShot = options.oneShot;
    this.#journal = options.journal;
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
    this.#merge =
      options.merge ??
      new MergeBack({
        worktreeRoot: this.#worktrees.root,
        gh: this.#gh,
        git: this.#git,
        now: this.#now,
        log: this.#log,
        messageFor: async ({ git, title, range }) => {
          const generated = await this.#generate({ git, threadTitle: title, kind: "commit", range });
          return generated === undefined ? undefined : formatCommitMessage(generated);
        },
      });
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
        if (event.useWorktree === true) this.#enqueue(event.thread.id, () => this.#createWorktree(event.thread.id, event.baseRef));
        return;
      case "turn.requested":
      case "turn.steer-fell-back":
        // a queued turn is snapshotted when it is promoted, not while the turn ahead still edits
        if (event.turn.status !== "queued") this.#gateBefore(event.turn.threadId, event.turn.id);
        return;
      case "turn.settled": {
        this.#enqueue(event.threadId, () => this.#recordAfter(event.threadId, event.turnId));
        // the projector just promoted the oldest queued turn (if any): its before-snapshot is
        // taken after this after-snapshot, on the same per-thread queue
        const model = this.#engine.getModel();
        const next = model.threads[event.threadId]?.latestTurnId;
        const turn = next === undefined ? undefined : model.turns[next];
        if (turn && turn.id !== event.turnId && turn.status === "requested" && turn.checkpoint === undefined) {
          this.#gateBefore(event.threadId, turn.id);
        }
        return;
      }
      case "checkpoint.recorded":
        if (event.phase === "after" && this.#gitSettings().pushThreadBranches === "on-checkpoint") {
          this.#enqueue(event.threadId, async () => void (await this.#pushBranch(event.threadId)));
        }
        return;
      case "thread.archived":
        // archiving frees the disk unless the user asked to keep the checkout; checkpoint refs
        // stay (unarchive needs them for diff/rollback/fork) and die only with the branch
        if (event.keepWorktree !== true) {
          this.#journaled(record.seq, event.threadId, "archive", async () => void (await this.#detach(event.threadId, false)));
        }
        return;
      case "thread.deleted":
        // a cascade emits one event per thread and those may share a checkout and a branch:
        // deletions run one at a time, so the second finds the directory and branch already gone
        this.#enqueue(event.threadId, () => this.#oneDeletionAtATime(() => this.#destroy(event)));
        return;
      case "worktree.detach-requested": {
        const { threadId, deleteBranch } = event;
        this.#journaled(record.seq, threadId, "detach", async () => {
          const detached = await this.#detach(threadId, deleteBranch === true);
          if (detached && deleteBranch === true) await this.#gcCheckpoints(threadId);
        });
        return;
      }
      case "merge.requested": {
        const { threadId, strategy, deleteBranch } = event;
        this.#enqueue(threadId, () => this.#mergeBack(threadId, strategy, deleteBranch === true));
        return;
      }
      case "worktree.attached":
        this.#track(this.#sessions?.close(event.threadId) ?? Promise.resolve());
        return;
      case "publish.requested": {
        const { threadId, title, body, commitOnly, mergeWhenGreen } = event;
        this.#journaled(record.seq, threadId, "publish", () => this.#publish(threadId, title, body, commitOnly === true, mergeWhenGreen));
        return;
      }
      default:
        return;
    }
  }

  /** Runs `task` on the thread's git queue (rollback's file restore must not race a checkpoint). */
  exclusive<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#enqueue(threadId, async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * B1/B2: boot-time reconciliation of git work the previous process left half-done (merges
   * stuck on `merging`, worktrees never attached, lost publish/detach intents, stale worktree
   * registrations). Runs on the same per-thread queues as live work. See `recovery.ts`.
   */
  recover(options: VcsRecoveryOptions = {}): Promise<VcsRecoveryReport> {
    return recoverVcs(
      {
        engine: this.#engine,
        worktrees: this.#worktrees,
        merge: this.#merge,
        git: this.#git,
        exclusive: (threadId, task) => this.exclusive(threadId, task),
        createWorktree: async (threadId, startRef) => {
          await this.#createWorktree(threadId, startRef);
          const failure = this.#worktreeFailures.get(threadId);
          // a turn that is resumed after the restart never passes `#recordBefore`: say it now
          if (failure !== undefined && this.#engine.getModel().threads[threadId]?.latestTurnId !== undefined) {
            this.#worktreeFailures.delete(threadId);
            await this.#info(threadId, "error", worktreeFailureText(failure));
          }
          return failure;
        },
        info: (threadId, kind, text, id) => this.#info(threadId, kind, text, id),
        detach: (threadId) => this.#detach(threadId, false),
        dispatch: (command) => this.#dispatch(command),
        ...(this.#onPrChange !== undefined ? { onPrChange: this.#onPrChange } : {}),
        log: this.#log,
      },
      { ...(this.#journal !== undefined ? { journal: this.#journal } : {}), ...options },
    );
  }

  // ---- plumbing ----

  /** `#enqueue`, with the intent written to the journal until the task is over (whatever its outcome). */
  #journaled(seq: number, threadId: string, kind: "publish" | "detach" | "archive", task: () => Promise<void>): void {
    const key = String(seq);
    this.#journal?.begin(key, { threadId, kind });
    this.#enqueue(threadId, async () => {
      try {
        await task();
      } finally {
        this.#journal?.end(key);
      }
    });
  }

  /**
   * Marked synchronously: the provider reactor's own listener runs right after this one and
   * must find a gate to wait on before it opens a session.
   */
  #gateBefore(threadId: string, turnId: string): void {
    this.#checkpoints.expect(turnId);
    this.#enqueue(threadId, () => this.#recordBefore(threadId, turnId));
  }

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

  /** Posts a row on the thread's latest turn (only logged when it has none); `id` makes the row idempotent. */
  async #info(threadId: string, kind: "info" | "error", text: string, id?: string): Promise<void> {
    const model = this.#engine.getModel();
    const turnId = model.threads[threadId]?.latestTurnId;
    if (turnId === undefined) {
      this.#log(`[vcs] ${kind}: ${text}`, threadId);
      return;
    }
    await this.#post(threadId, turnId, kind, text, id);
  }

  /** Same, but on a turn the caller already holds (the before-checkpoint path). */
  async #post(threadId: string, turnId: string, kind: "info" | "error", text: string, id?: string): Promise<void> {
    const at = this.#now();
    const activity: Activity = { id: id ?? this.#newId(), threadId, turnId, kind, text, createdAt: at, updatedAt: at };
    await this.#dispatch({ type: "activity.upsert", activity });
  }

  #gitSettings(): ReactorGitSettings {
    return this.#settings?.get().git ?? GIT_OFF;
  }

  /** C5: generated text when the user wants it and a harness answers; undefined keeps the fallback. */
  async #generate(input: Parameters<typeof generateCommitMessage>[1]): Promise<{ subject: string; body?: string } | undefined> {
    if (this.#oneShot === undefined || !this.#gitSettings().generateMessages) return undefined;
    return generateCommitMessage(this.#oneShot, input);
  }

  // ---- handlers ----

  /**
   * B4: pushes the thread's `tide/*` branch to origin and records it (`branch.pushed`). Only what
   * is committed on the branch travels. A failure is said once per failure streak (info), and the
   * merge or checkpoint that asked for the push carries on. Returns true when origin has the branch.
   */
  async #pushBranch(threadId: string): Promise<boolean> {
    const ctx = this.#context(threadId);
    const branch = ctx?.thread.branch;
    if (!ctx || branch === undefined || ctx.thread.worktreePath === undefined) return false;
    const root = this.#git(ctx.project.rootPath);
    if (!(await hasOrigin(root))) return false;
    const sha = await root.revParse(`refs/heads/${branch}`);
    if (sha !== undefined && ctx.thread.pushedSha === sha && ctx.thread.remoteBranch === branch) return true;
    const pushed = await pushThreadBranch(root, branch);
    if (pushed.ok) {
      this.#pushMuted.delete(threadId);
      await this.#dispatch({ type: "branch.pushed", threadId, remoteBranch: pushed.remoteBranch, sha: pushed.sha });
      return true;
    }
    if (!this.#pushMuted.has(threadId)) {
      this.#pushMuted.add(threadId);
      await this.#info(threadId, "info", `Could not push ${branch} to origin: ${pushed.error}`);
    }
    return false;
  }

  /**
   * Worktree creation happens before the thread has a turn, so a failure is remembered here and
   * reported as an error activity on the thread's first turn (see `#recordBefore`): the thread
   * silently falling back to the project's main checkout is exactly what the user must know.
   */
  async #createWorktree(threadId: string, startRef?: string): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    try {
      const info = await this.#worktrees.create(ctx.project, ctx.thread, startRef);
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
    await this.#post(threadId, turnId, "error", worktreeFailureText(reason));
  }

  /**
   * Tears a thread's worktree down: closes the harness session holding the cwd open, parks any
   * uncommitted work on a ref so archiving can never lose it, removes the checkout (the branch
   * survives) and records the fact through the server-internal command path. `deleteBranch` is
   * honoured only for Tide-owned `tide/*` branches — anything else is refused and logged.
   * A failure is posted on the thread as an error: the user must know the checkout is still there.
   * Returns true when the worktree is gone.
   */
  async #detach(threadId: string, deleteBranch: boolean): Promise<boolean> {
    const ctx = this.#context(threadId);
    if (!ctx || ctx.thread.worktreePath === undefined) return false;
    const worktreePath = ctx.thread.worktreePath;
    try {
      await this.#sessions?.close(threadId);
      // R5: a checkout another live thread still runs in (inheritWorktreeFrom) stays on disk,
      // with its branch; this thread only lets go of it
      const sharer = sharingThread(ctx.model, ctx.thread);
      if (sharer !== undefined) {
        this.#log(`[vcs] worktree of ${threadId} kept: thread ${sharer.id} still uses it`);
        await this.#dispatch({ type: "worktree.detached", threadId });
        return true;
      }
      try {
        await this.#preserve(threadId, worktreePath);
      } catch (err) {
        // never remove a checkout whose uncommitted work could not be parked
        await this.#info(threadId, "error", `Worktree kept: its uncommitted work could not be preserved (${message(err)})`);
        return false;
      }
      this.#onDetach?.(threadId, worktreePath);
      await this.#worktrees.remove(ctx.project, ctx.thread);
      if (deleteBranch) await this.#deleteBranch(ctx.project.rootPath, ctx.thread.branch);
      await this.#dispatch({ type: "worktree.detached", threadId });
      return true;
    } catch (err) {
      this.#log("[vcs] worktree detach failed", err);
      await this.#info(threadId, "error", `Worktree could not be removed: ${message(err)}`);
      return false;
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

  /** Drops `refs/tide/checkpoints/<threadId>/*`; called only once the thread's branch is deleted. */
  async #gcCheckpoints(threadId: string): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    try {
      const removed = await this.#checkpoints.deleteThreadRefs(ctx.project.rootPath, threadId);
      if (removed > 0) this.#log(`[vcs] removed ${removed} checkpoint ref(s) of ${threadId}`);
    } catch (err) {
      this.#log("[vcs] checkpoint ref cleanup failed", err);
    }
  }

  /**
   * `thread.deleted`: the thread is already gone from the model, so everything comes from the
   * event. Session, worktree, `tide/*` branch, checkpoint refs and the archived-work ref go, each
   * best-effort and logged (there is no thread left to post an error on). Nothing still in the
   * model is touched: a checkout or branch another thread uses stays. A cascade sharing one
   * checkout removes it on the first event; later ones find it gone and skip quietly.
   */
  async #destroy(event: EventOf<"thread.deleted">): Promise<void> {
    const { threadId, worktreePath, branch } = event;
    const model = this.#engine.getModel();
    const project = model.projects[event.projectId];
    const step = async (what: string, task: () => Promise<void>): Promise<void> => {
      try {
        await task();
      } catch (err) {
        this.#log(`[vcs] delete ${threadId}: ${what} failed`, err);
      }
    };
    await step("session close", async () => void (await this.#sessions?.close(threadId)));
    if (!project) {
      this.#log(`[vcs] delete ${threadId}: unknown project ${event.projectId}; repository left as is`);
      return;
    }
    const others = Object.values(model.threads).filter((t) => t.id !== threadId);
    if (worktreePath !== undefined) {
      if (worktreePath === project.rootPath || others.some((t) => t.worktreePath === worktreePath)) {
        this.#log(`[vcs] delete ${threadId}: worktree ${worktreePath} kept, still in use`);
      } else {
        this.#onDetach?.(threadId, worktreePath);
        if (existsSync(worktreePath)) await step("worktree removal", () => this.#worktrees.removePath(project.rootPath, worktreePath));
      }
    }
    if (branch !== undefined && others.some((t) => t.branch === branch)) {
      this.#log(`[vcs] delete ${threadId}: branch ${branch} kept, another thread uses it`);
    } else if (branch !== undefined && (await this.#git(project.rootPath).revParse(`refs/heads/${branch}`)) === undefined) {
      // already gone: an earlier thread of the same cascade shared it
    } else {
      await step("branch deletion", () => this.#deleteBranch(project.rootPath, branch));
    }
    await step("checkpoint ref cleanup", async () => {
      const removed = await this.#checkpoints.deleteThreadRefs(project.rootPath, threadId);
      if (removed > 0) this.#log(`[vcs] removed ${removed} checkpoint ref(s) of ${threadId}`);
    });
    await step("archived ref cleanup", () => this.#git(project.rootPath).deleteRef(`refs/tide/archived/${threadId}`));
    this.#worktreeFailures.delete(threadId);
  }

  #oneDeletionAtATime(task: () => Promise<void>): Promise<void> {
    const next = this.#deletions.then(task);
    this.#deletions = next.catch(() => undefined);
    return next;
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

  /**
   * Merge-back of the thread's branch into its base (see MergeBack). The outcome is reported as
   * `merge.report`; with `deleteBranch` the worktree goes through the ordinary detach path, the
   * `tide/*` branch is deleted and the thread's checkpoint refs are dropped.
   *
   * With an origin: `syncBaseWithRemote` fetches and fast-forwards the base before a local merge
   * (an unreachable origin only warns; a dirty-behind or diverged base refuses), and
   * `pushBaseAfterMerge` pushes the base after it. The two are independent; the push is off by default.
   */
  async #mergeBack(threadId: string, strategy: MergeStrategy, deleteBranch: boolean): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    const { thread, project } = ctx;
    const gitSettings = this.#gitSettings();
    const root = this.#git(project.rootPath);
    const remote =
      (gitSettings.pushThreadBranches !== "never" || gitSettings.syncBaseWithRemote || gitSettings.pushBaseAfterMerge) && (await hasOrigin(root));
    const local = !(await this.#merge.usesPr(thread));
    if (remote && gitSettings.pushThreadBranches === "on-merge-request") {
      await this.#merge.commitPending(thread).catch((err: unknown) => this.#log("[vcs] commit before push failed", err));
      await this.#pushBranch(threadId);
    }
    let synced: string | undefined;
    if (remote && local && gitSettings.syncBaseWithRemote && thread.baseBranch !== undefined) {
      // a known-stale base is never merged into: fast-forward from origin first, or refuse
      const before = await syncBase(root, thread.baseBranch);
      if (!before.ok) {
        await this.#dispatch({ type: "merge.report", threadId, outcome: "error", error: before.note });
        await this.#info(threadId, "error", `Merge not started: ${before.note}`);
        return;
      }
      synced = before.note;
      // origin out of reach: the merge proceeds on the local base, and the thread says so
      if (before.warning !== undefined) await this.#info(threadId, "info", `Base not synced: ${before.warning}`);
    }
    const result = await this.#merge.merge(project, thread, strategy, deleteBranch);
    if (result.outcome === "conflicted") {
      await this.#dispatch({ type: "merge.report", threadId, outcome: "conflicted", files: result.files });
      await this.#info(threadId, "error", `Merge into ${thread.baseBranch ?? "base"} conflicts in ${result.files.join(", ")}; nothing was changed`);
      return;
    }
    if (result.outcome === "error") {
      await this.#dispatch({ type: "merge.report", threadId, outcome: "error", error: result.error });
      await this.#info(threadId, "error", `Merge failed: ${result.error}`);
      return;
    }
    if (result.pr !== undefined) await this.#dispatch({ type: "pr.update", threadId, pr: result.pr });
    let branchDeleted = false;
    if (deleteBranch) {
      await this.#detach(threadId, true);
      branchDeleted = thread.branch !== undefined && (await this.#git(project.rootPath).revParse(`refs/heads/${thread.branch}`)) === undefined;
      await this.#gcCheckpoints(threadId);
    }
    await this.#dispatch({
      type: "merge.report",
      threadId,
      outcome: "merged",
      ...(result.sha !== undefined ? { sha: result.sha } : {}),
      ...(deleteBranch ? { branchDeleted } : {}),
    });
    this.#onPrChange?.(threadId);
    const where = result.pr !== undefined ? `via pull request #${result.pr.number}` : `(${strategy}${result.sha !== undefined ? ` ${result.sha.slice(0, 8)}` : ""})`;
    const notes = [synced, result.note].filter((n): n is string => n !== undefined).map((n) => `. ${n}`).join("");
    await this.#info(threadId, "info", `Merged ${thread.branch ?? "branch"} into ${thread.baseBranch ?? "base"} ${where}${notes}`);
    if (remote && local && gitSettings.pushBaseAfterMerge && thread.baseBranch !== undefined && result.pr === undefined) {
      // the merge stands either way (settle already fired); a failed push is the user's to resolve
      const pushed = await pushBase(root, thread.baseBranch);
      if (!pushed.ok) await this.#info(threadId, "error", `${thread.baseBranch} merged locally but not pushed: ${pushed.error}`);
    }
  }

  async #publish(
    threadId: string,
    title: string | undefined,
    body: string | undefined,
    commitOnly: boolean,
    mergeWhenGreen: MergeStrategy | undefined,
  ): Promise<void> {
    const ctx = this.#context(threadId);
    if (!ctx) return;
    const git = this.#git(ctx.cwd);
    let commitMessage = title ?? `tide: ${ctx.thread.title}`;
    try {
      if (!(await git.isRepo())) {
        await this.#info(threadId, "error", `Publish failed: ${ctx.cwd} is not a git repository`);
        return;
      }
      if (title === undefined) commitMessage = await this.#publishCommitMessage(git, ctx.thread, commitMessage);
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
      const pr = await this.#openOrUpdatePr(threadId, ctx.cwd, ctx.thread, branch, title, body);
      if (pr !== undefined && mergeWhenGreen !== undefined) await this.#autoMerge(threadId, ctx.cwd, pr, mergeWhenGreen);
      if (pr !== undefined) this.#onPrChange?.(threadId);
    } catch (err) {
      await this.#info(threadId, "error", `Publish failed: ${message(err)}`);
    }
  }

  async #openOrUpdatePr(
    threadId: string,
    cwd: string,
    thread: Thread,
    branch: string,
    givenTitle: string | undefined,
    givenBody: string | undefined,
  ): Promise<PullRequest | undefined> {
    if (!(await this.#gh.hasGh())) {
      await this.#info(threadId, "info", `Pushed ${branch}; install the GitHub CLI to open a pull request`);
      return undefined;
    }
    const existing = await this.#gh.prView(cwd, branch);
    let title = givenTitle ?? `tide: ${thread.title}`;
    let body = givenBody;
    if (!existing && (givenTitle === undefined || givenBody === undefined)) {
      const base = thread.baseBranch;
      const generated = await this.#generate({ git: this.#git(cwd), threadTitle: thread.title, kind: "pr", range: [base !== undefined ? `${base}...HEAD` : "HEAD~1"] });
      if (generated !== undefined) {
        title = givenTitle ?? generated.subject;
        body = givenBody ?? generated.body;
      }
    }
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
    return pr;
  }

  /** C5: the publish commit (no title given) described from everything the branch will carry. */
  async #publishCommitMessage(git: Git, thread: Thread, fallback: string): Promise<string> {
    if (this.#oneShot === undefined || !this.#gitSettings().generateMessages) return fallback;
    await git.run(["add", "-A"]);
    const generated = await this.#generate({ git, threadTitle: thread.title, kind: "commit", range: ["--cached"] });
    return generated === undefined ? fallback : formatCommitMessage(generated);
  }

  /** publish's `mergeWhenGreen`: GitHub merges the PR once its required checks pass. */
  async #autoMerge(threadId: string, cwd: string, pr: PullRequest, strategy: MergeStrategy): Promise<void> {
    if (this.#gh.prMerge === undefined) return;
    try {
      await this.#gh.prMerge(cwd, pr.number, { strategy, auto: true });
      await this.#info(threadId, "info", `Auto-merge (${strategy}) enabled on pull request #${pr.number}`);
    } catch (err) {
      await this.#info(threadId, "error", `Auto-merge could not be enabled on #${pr.number}: ${message(err)}`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Starts with WORKTREE_FAILURE_PREFIX (recovery.ts looks for it before warning a second time). */
function worktreeFailureText(reason: string): string {
  return `Worktree could not be created (${reason}); this thread runs in the project's main checkout — file restore and publish are disabled.`;
}
