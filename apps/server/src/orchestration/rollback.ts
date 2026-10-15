import { newId as defaultNewId, type Activity, type EventOf, type EventRecord, type InternalCommand } from "@tide/contracts";
import { resumableSessionId, threadCwd, type SessionDirectory } from "../provider/sessions.ts";
import type { CheckpointService } from "../vcs/checkpoints.ts";
import { restoreBeforeTurn, sharedCheckoutReason } from "../vcs/restore.ts";
import type { Engine } from "./engine.ts";

export interface RollbackServiceOptions {
  engine: Engine;
  sessions: Pick<SessionDirectory, "peek" | "getOrOpen" | "caps" | "touch">;
  checkpoints: CheckpointService;
  /** serialises the file restore with the thread's other git work (the vcs reactor's queue) */
  exclusive?: <T>(threadId: string, task: () => Promise<T>) => Promise<T>;
  realpath?: (path: string) => Promise<string>;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * Carries out a `rollback.requested`: (a) the harness forgets the rolled-back turns it ran (when
 * it can), (b) with `restoreFiles` the worktree returns to the first rolled-back turn's
 * before-checkpoint, (c) the outcome goes back as `rollback.report`. The safety checks for (b)
 * run first, so a refused restore never leaves the conversation half rewound.
 */
export class RollbackService {
  #engine: Engine;
  #sessions: RollbackServiceOptions["sessions"];
  #checkpoints: CheckpointService;
  #exclusive: <T>(threadId: string, task: () => Promise<T>) => Promise<T>;
  #realpath: ((path: string) => Promise<string>) | undefined;
  #now: () => number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: RollbackServiceOptions) {
    this.#engine = options.engine;
    this.#sessions = options.sessions;
    this.#checkpoints = options.checkpoints;
    this.#exclusive = options.exclusive ?? ((_threadId, task) => task());
    this.#realpath = options.realpath;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) return;
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("rollback service did not drain");
  }

  #onRecord(record: EventRecord): void {
    if (record.event.type !== "rollback.requested") return;
    const tracked = this.#run(record.event).finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  async #run(event: EventOf<"rollback.requested">): Promise<void> {
    const { threadId } = event;
    let kept: string | undefined;
    let nativeSessionId: string | undefined;
    try {
      const model = this.#engine.getModel();
      const thread = model.threads[threadId];
      const project = thread ? model.projects[thread.projectId] : undefined;
      if (!thread || !project) throw new Error("thread or project is gone");
      if (event.restoreFiles) {
        const refused = await sharedCheckoutReason(model, thread, project, this.#realpath);
        if (refused !== undefined) throw new Error(`files not restored: ${refused}`);
      }

      // (a) only the rolled-back turns this harness actually ran are in its conversation
      const harnessTurns = event.turnIds.filter((id) => {
        const turn = model.turns[id];
        return turn?.provider === thread.provider && turn.startedAt !== undefined;
      }).length;
      const hasSession = this.#sessions.peek(threadId) !== undefined || resumableSessionId(thread, model) !== undefined;
      if (harnessTurns > 0 && hasSession) {
        const caps = await this.#sessions.caps(thread.provider);
        if (caps.rollback === true) {
          const session = await this.#sessions.getOrOpen(thread, project);
          if (session.rollback === undefined) throw new Error(`${thread.provider} driver reports rollback but does not implement it`);
          await session.rollback(harnessTurns);
          this.#sessions.touch(threadId);
          // Pi writes a new session file and Claude may re-mint: the log must learn the id now, not at the next turn
          if (session.nativeSessionId !== undefined && session.nativeSessionId !== thread.nativeSessionId) nativeSessionId = session.nativeSessionId;
        } else {
          kept = `harness ${thread.provider} cannot forget turns; the conversation was not rewound`;
        }
      }

      // (b)
      if (event.restoreFiles) {
        const cwd = threadCwd(thread, project);
        await this.#exclusive(threadId, () => restoreBeforeTurn(this.#checkpoints, model, threadId, event.turnId, cwd));
      }
      // nothing can revert to a rolled-back turn any more
      try {
        await this.#exclusive(threadId, () => this.#checkpoints.deleteTurnRefs(project.rootPath, threadId, event.turnIds));
      } catch (err) {
        this.#log("[rollback] checkpoint ref cleanup failed", err);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#log("[rollback] failed", { threadId, error });
      await this.#dispatch({ type: "rollback.report", threadId, outcome: "error", error });
      return;
    }
    // (c)
    await this.#dispatch({ type: "rollback.report", threadId, outcome: "done", ...(nativeSessionId !== undefined ? { nativeSessionId } : {}) });
    if (kept !== undefined) {
      const turnId = this.#engine.getModel().threads[threadId]?.latestTurnId ?? event.turnId;
      const at = this.#now();
      const activity: Activity = { id: this.#newId(), threadId, turnId, kind: "info", text: kept, createdAt: at, updatedAt: at };
      await this.#dispatch({ type: "activity.upsert", activity });
    }
  }

  async #dispatch(command: InternalCommand): Promise<void> {
    try {
      await this.#engine.dispatch(command);
    } catch (err) {
      this.#log(`[rollback] ${command.type} rejected`, err);
    }
  }
}
