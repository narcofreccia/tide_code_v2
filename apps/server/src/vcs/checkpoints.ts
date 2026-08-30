import type { CheckpointStats, DiffResult, Thread, Turn } from "@tide/contracts";
import { Git, WORKTREE } from "./git.ts";

export type CheckpointPhase = "before" | "after";

export interface RecordedCheckpoint {
  ref: string;
  sha: string;
  stats?: CheckpointStats;
}

export interface CheckpointServiceOptions {
  git?: (cwd: string) => Git;
  log?: (msg: string, data?: unknown) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function checkpointRef(threadId: string, turnId: string, phase: CheckpointPhase): string {
  return `refs/tide/checkpoints/${threadId}/${turnId}/${phase}`;
}

export function sumStats(files: { additions: number; deletions: number }[]): CheckpointStats {
  return files.reduce<CheckpointStats>(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

/**
 * Per-turn working-tree snapshots stored as commits behind
 * `refs/tide/checkpoints/<threadId>/<turnId>/{before,after}`. Refs (not branches) keep them
 * invisible to the user's git UI while still protecting the objects from gc.
 */
export class CheckpointService {
  #git: (cwd: string) => Git;
  #log: (msg: string, data?: unknown) => void;
  /** turnId -> gate the provider reactor waits on so the before-snapshot precedes tool calls */
  #gates = new Map<string, Deferred>();

  constructor(options: CheckpointServiceOptions = {}) {
    this.#git = options.git ?? ((cwd) => new Git(cwd));
    this.#log = options.log ?? (() => undefined);
  }

  /**
   * Marks a turn as "a before-snapshot is coming". Must run synchronously while the
   * `turn.requested` event is being delivered, before the provider reactor enqueues the turn.
   */
  expect(turnId: string): void {
    if (!this.#gates.has(turnId)) this.#gates.set(turnId, deferred());
  }

  /** Resolves once the before-snapshot for this turn is recorded (or immediately if none is due). */
  beforeReady(turnId: string): Promise<void> {
    return this.#gates.get(turnId)?.promise ?? Promise.resolve();
  }

  /** Opens the gate whatever happened, so a git failure can never stall a turn. */
  release(turnId: string): void {
    const gate = this.#gates.get(turnId);
    if (!gate) return;
    this.#gates.delete(turnId);
    gate.resolve();
  }

  async recordBefore(cwd: string, threadId: string, turnId: string): Promise<RecordedCheckpoint> {
    try {
      return await this.#record(cwd, threadId, turnId, "before");
    } finally {
      this.release(turnId);
    }
  }

  /** After-snapshot plus before→after stats (undefined stats when the before-ref is gone). */
  async recordAfter(cwd: string, threadId: string, turnId: string): Promise<RecordedCheckpoint> {
    const recorded = await this.#record(cwd, threadId, turnId, "after");
    const git = this.#git(cwd);
    const before = await git.revParse(checkpointRef(threadId, turnId, "before"));
    if (before === undefined) return recorded;
    const files = await git.diff(before, recorded.sha, { stat: true });
    return { ...recorded, stats: sumStats(files) };
  }

  async #record(cwd: string, threadId: string, turnId: string, phase: CheckpointPhase): Promise<RecordedCheckpoint> {
    const git = this.#git(cwd);
    const sha = await git.snapshot(`tide checkpoint ${phase} ${turnId}`);
    const ref = checkpointRef(threadId, turnId, phase);
    await git.updateRef(ref, sha);
    return { ref, sha };
  }

  /** before → after for one turn; falls back to the live working tree while the turn is running. */
  async turnDiff(cwd: string, turn: Turn): Promise<DiffResult> {
    const before = turn.checkpoint?.before;
    if (before === undefined) return { base: "", head: WORKTREE, files: [] };
    const head = turn.checkpoint?.after ?? WORKTREE;
    return { base: before, head, files: await this.#git(cwd).diff(before, head) };
  }

  /**
   * Everything the thread changed: the first turn's before-checkpoint (else the fork point
   * `baseBranch`, else HEAD) → the working tree.
   */
  async threadDiff(cwd: string, thread: Thread, turns: Turn[]): Promise<DiffResult> {
    const git = this.#git(cwd);
    const base = await this.#threadBase(git, thread, turns);
    if (base === undefined) return { base: "", head: WORKTREE, files: [] };
    return { base, head: WORKTREE, files: await git.diff(base, WORKTREE) };
  }

  async #threadBase(git: Git, thread: Thread, turns: Turn[]): Promise<string | undefined> {
    const ordered = [...turns].sort((a, b) => a.requestedAt - b.requestedAt);
    for (const turn of ordered) {
      const ref = turn.checkpoint?.before;
      if (ref === undefined) continue;
      const sha = await git.revParse(ref);
      if (sha !== undefined) return sha;
    }
    if (thread.baseBranch !== undefined) {
      const sha = await git.revParse(thread.baseBranch);
      if (sha !== undefined) return sha;
    }
    return git.revParse("HEAD");
  }

  /** Restores the working tree to a before-checkpoint. HEAD and branches are left alone. */
  async revertTo(cwd: string, beforeRef: string): Promise<void> {
    const git = this.#git(cwd);
    const sha = await git.revParse(beforeRef);
    if (sha === undefined) throw new Error(`checkpoint ${beforeRef} no longer exists`);
    this.#log("[vcs] reverting working tree", { cwd, ref: beforeRef });
    await git.checkoutTree(sha);
  }
}
