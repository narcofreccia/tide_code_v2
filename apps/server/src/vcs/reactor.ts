import {
  newId as defaultNewId,
  type EventOf,
  type EventRecord,
  type InternalCommand,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { SessionDirectory } from "../provider/sessions.ts";
import type { OneShotDeps } from "../rpc/oneShot.ts";
import type { SettingsStore } from "../settings.ts";
import { CheckpointService } from "./checkpoints.ts";
import { Git } from "./git.ts";
import { Gh, type GhLike } from "./gh.ts";
import { MergeBack } from "./merge.ts";
import { formatCommitMessage } from "./messages.ts";
import { recoverVcs, type IntentJournal, type VcsRecoveryOptions, type VcsRecoveryReport } from "./recovery.ts";
import { recordAfter, recordBefore } from "./reactorCheckpoints.ts";
import { dispatch, generate, gitSettings, info, type VcsEnv } from "./reactorEnv.ts";
import { mergeBack, pushBranch } from "./reactorMerge.ts";
import { publish } from "./reactorPublish.ts";
import { createWorktree, destroy, detach, gcCheckpoints } from "./reactorWorktree.ts";
import { worktreeFailureText, WorktreeManager } from "./worktrees.ts";

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

/**
 * Git side of the orchestration loop. Reacts to domain events with real git work and reports
 * the outcome back as internal commands — it decides nothing. Every repository operation for
 * one thread runs on that thread's own queue, and the engine listener never awaits any of it.
 * The handlers live in `reactor{Worktree,Checkpoints,Merge,Publish}.ts` and share `VcsEnv`.
 */
export class VcsReactor {
  #env: VcsEnv;
  #queues = new Map<string, Promise<void>>();
  /** tail of the `thread.deleted` chain (see `#oneDeletionAtATime`) */
  #deletions: Promise<void> = Promise.resolve();
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: VcsReactorOptions) {
    const gh = options.gh ?? new Gh();
    const git = options.git ?? ((cwd: string) => new Git(cwd));
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? ((msg: string, data?: unknown) => (data === undefined ? console.error(msg) : console.error(msg, data)));
    const env: VcsEnv = {
      engine: options.engine,
      worktrees: options.worktrees,
      checkpoints: options.checkpoints,
      sessions: options.sessions,
      gh,
      git,
      onDetach: options.onDetach,
      onPrChange: options.onPrChange,
      settings: options.settings,
      oneShot: options.oneShot,
      journal: options.journal,
      now,
      newId: options.newId ?? (() => defaultNewId()),
      log,
      pushMuted: new Set(),
      worktreeFailures: new Map(),
      worktreeNotices: new Map(),
      merge:
        options.merge ??
        new MergeBack({
          worktreeRoot: options.worktrees.root,
          gh,
          git,
          now,
          log,
          messageFor: async ({ git: repo, title, range }) => {
            const generated = await generate(env, { git: repo, threadTitle: title, kind: "commit", range });
            return generated === undefined ? undefined : formatCommitMessage(generated);
          },
        }),
    };
    this.#env = env;
  }

  start(): void {
    this.#unsubscribe ??= this.#env.engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Resolves when the engine is drained and no git work is in flight. */
  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#env.engine.drain();
      if (this.#inflight.size === 0) {
        await this.#env.engine.drain();
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
        if (event.useWorktree === true) this.#enqueue(event.thread.id, () => createWorktree(this.#env, event.thread.id, event.baseRef));
        return;
      case "turn.requested":
      case "turn.steer-fell-back":
        // a queued turn is snapshotted when it is promoted, not while the turn ahead still edits
        if (event.turn.status !== "queued") this.#gateBefore(event.turn.threadId, event.turn.id);
        return;
      case "turn.settled": {
        this.#enqueue(event.threadId, () => recordAfter(this.#env, event.threadId, event.turnId));
        // the projector just promoted the oldest queued turn (if any): its before-snapshot is
        // taken after this after-snapshot, on the same per-thread queue
        const model = this.#env.engine.getModel();
        const next = model.threads[event.threadId]?.latestTurnId;
        const turn = next === undefined ? undefined : model.turns[next];
        if (turn && turn.id !== event.turnId && turn.status === "requested" && turn.checkpoint === undefined) {
          this.#gateBefore(event.threadId, turn.id);
        }
        return;
      }
      case "checkpoint.recorded":
        if (event.phase === "after" && gitSettings(this.#env).pushThreadBranches === "on-checkpoint") {
          this.#enqueue(event.threadId, async () => void (await pushBranch(this.#env, event.threadId)));
        }
        return;
      case "thread.archived":
        // archiving frees the disk unless the user asked to keep the checkout; checkpoint refs
        // stay (unarchive needs them for diff/rollback/fork) and die only with the branch
        if (event.keepWorktree !== true) {
          this.#journaled(record.seq, event.threadId, "archive", async () => void (await detach(this.#env, event.threadId, false)));
        }
        return;
      case "thread.deleted":
        // a cascade emits one event per thread and those may share a checkout and a branch:
        // deletions run one at a time, so the second finds the directory and branch already gone
        this.#enqueue(event.threadId, () => this.#oneDeletionAtATime(() => destroy(this.#env, event)));
        return;
      case "worktree.detach-requested": {
        const { threadId, deleteBranch } = event;
        this.#journaled(record.seq, threadId, "detach", async () => {
          const detached = await detach(this.#env, threadId, deleteBranch === true);
          if (detached && deleteBranch === true) await gcCheckpoints(this.#env, threadId);
        });
        return;
      }
      case "merge.requested": {
        const { threadId, strategy, deleteBranch } = event;
        // the journal entry (written by #mergeBack once the base head is known) lives until the merge is over
        const key = String(record.seq);
        this.#enqueue(threadId, async () => {
          try {
            await mergeBack(this.#env, threadId, strategy, deleteBranch === true, key);
          } finally {
            this.#env.journal?.end(key);
          }
        });
        return;
      }
      case "worktree.attached":
        this.#env.worktreeFailures.delete(event.threadId);
        this.#track(this.#env.sessions?.close(event.threadId) ?? Promise.resolve());
        return;
      case "publish.requested": {
        const { threadId, title, body, commitOnly, mergeWhenGreen } = event;
        this.#journaled(record.seq, threadId, "publish", () => publish(this.#env, threadId, title, body, commitOnly === true, mergeWhenGreen));
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
    const env = this.#env;
    return recoverVcs(
      {
        engine: env.engine,
        worktrees: env.worktrees,
        merge: env.merge,
        git: env.git,
        exclusive: (threadId, task) => this.exclusive(threadId, task),
        createWorktree: async (threadId, startRef) => {
          await createWorktree(env, threadId, startRef);
          const failure = env.worktreeFailures.get(threadId);
          // a turn that is resumed after the restart never passes `recordBefore`: say it now
          // (the failure stays: the thread's next turns are still refused)
          if (failure !== undefined && env.engine.getModel().threads[threadId]?.latestTurnId !== undefined) {
            await info(env, threadId, "error", worktreeFailureText(failure));
          }
          return failure;
        },
        worktreeFailed: async (threadId, reason) => {
          env.worktreeFailures.set(threadId, reason);
          await info(env, threadId, "error", worktreeFailureText(reason));
        },
        info: (threadId, kind, text, id) => info(env, threadId, kind, text, id),
        detach: (threadId) => detach(env, threadId, false),
        dispatch: (command) => dispatch(env, command),
        ...(env.onPrChange !== undefined ? { onPrChange: env.onPrChange } : {}),
        log: env.log,
      },
      { ...(env.journal !== undefined ? { journal: env.journal } : {}), ...options },
    );
  }

  // ---- plumbing ----

  /** `#enqueue`, with the intent written to the journal until the task is over (whatever its outcome). */
  #journaled(seq: number, threadId: string, kind: "publish" | "detach" | "archive", task: () => Promise<void>): void {
    const key = String(seq);
    this.#env.journal?.begin(key, { threadId, kind });
    this.#enqueue(threadId, async () => {
      try {
        await task();
      } finally {
        this.#env.journal?.end(key);
      }
    });
  }

  /**
   * Marked synchronously: the provider reactor's own listener runs right after this one and
   * must find a gate to wait on before it opens a session.
   */
  #gateBefore(threadId: string, turnId: string): void {
    this.#env.checkpoints.expect(turnId);
    this.#enqueue(threadId, () => recordBefore(this.#env, threadId, turnId));
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  #enqueue(threadId: string, task: () => Promise<void>): void {
    const queue = (this.#queues.get(threadId) ?? Promise.resolve())
      .then(task)
      .catch((err: unknown) => this.#env.log("[vcs] task failed", err));
    this.#queues.set(threadId, queue);
    this.#track(queue);
  }

  #oneDeletionAtATime(task: () => Promise<void>): Promise<void> {
    const next = this.#deletions.then(task);
    this.#deletions = next.catch(() => undefined);
    return next;
  }
}
