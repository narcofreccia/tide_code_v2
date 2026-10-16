import type { Activity, ActivityOf, ReadModel, Turn } from "@tide/contracts";
import type { Engine } from "./engine.ts";

export const RESTART_ERROR = "server restarted while this turn was running";
export const SHUTDOWN_ERROR = "server shutting down";

export interface RecoveryOptions {
  log?: (msg: string, data?: unknown) => void;
  now?: () => number;
  /** runs a `requested` turn that was never handed to a harness (no startedAt): a graceful shutdown leaves these behind */
  resume?: (threadId: string, turnId: string) => void;
}

export interface RecoveryReport {
  /** dead turns settled with RESTART_ERROR */
  turns: number;
  activities: number;
  /** queued turns that become live because the dead turn ahead of them settled */
  promoted: number;
  /** threads whose dead turn was settled with RESTART_ERROR (candidates for a continuation) */
  threadIds: string[];
}

/** Turns the harness may still have been working on when the process went away. */
export function unsettledTurns(model: ReadModel): Turn[] {
  return Object.values(model.turns)
    .filter((turn) => turn.status === "queued" || turn.status === "requested" || turn.status === "running")
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

type Prompt = ActivityOf<"approval"> | ActivityOf<"user-input">;

/** Approvals/questions of a turn that nobody can answer any more. */
function pendingPrompts(model: ReadModel, turn: Turn): Prompt[] {
  const out: Prompt[] = [];
  for (const entry of model.threadTimeline[turn.threadId] ?? []) {
    if (entry.kind !== "activity") continue;
    const activity = model.activities[entry.id];
    if (!activity || activity.turnId !== turn.id) continue;
    if (activity.kind !== "approval" && activity.kind !== "user-input") continue;
    if (activity.status === "pending") out.push(activity);
  }
  return out;
}

/**
 * A provider session never survives the process that opened it, so any turn still `requested`
 * or `running` in the replayed log is dead: without this pass the thread stays `running`
 * forever and every later `turn.request` / `thread.rollback` is rejected as `busy`.
 *
 * Queued turns were never handed to a harness, so they are *not* dead: settling the turn ahead
 * of them lets the projector promote the oldest one, and the provider reactor runs it. That is
 * why this pass runs *after* the reactors subscribe — the vcs reactor records the dead turn's
 * after-checkpoint, the experts reactor sees the settle, the provider reactor picks up the
 * promotion. A queued turn with nothing live ahead of it (a log that should not exist) can
 * never be promoted and is settled as dead too.
 */
export async function recoverUnsettledTurns(engine: Engine, options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const report: RecoveryReport = { turns: 0, activities: 0, promoted: 0, threadIds: [] };

  const byThread = new Map<string, Turn[]>();
  for (const turn of unsettledTurns(engine.getModel())) {
    const list = byThread.get(turn.threadId) ?? [];
    list.push(turn);
    byThread.set(turn.threadId, list);
  }

  for (const turns of byThread.values()) {
    // a requested turn with no startedAt was never sent: the previous process shut down before
    // running it (or it was promoted at shutdown). It is still runnable, unless something
    // running sits ahead of it in the log.
    const running = turns.filter((t) => t.status === "running" || (t.status === "requested" && t.startedAt !== undefined));
    const unsent = turns.filter((t) => t.status === "requested" && t.startedAt === undefined);
    if (running.length === 0 && unsent.length === 1 && options.resume) {
      const turn = unsent[0] as Turn;
      options.resume(turn.threadId, turn.id);
      report.promoted++;
      continue;
    }
    const live = turns.filter((t) => t.status !== "queued");
    const queued = turns.filter((t) => t.status === "queued");
    const dead = live.length > 0 ? live : queued;
    for (const turn of dead) {
      // the model moves under us: a settle promotes a queued turn, which must not be killed
      const model = engine.getModel();
      const current = model.turns[turn.id];
      if (current === undefined || (live.length > 0 && current.status !== turn.status)) continue;
      // resolved before the settle so the "cancel" decision survives the projector's own
      // blanket resolve of a settled turn's pending prompts
      for (const activity of pendingPrompts(model, turn)) {
        const resolved: Activity =
          activity.kind === "approval"
            ? { ...activity, status: "resolved", decision: "cancel", updatedAt: now() }
            : { ...activity, status: "resolved", updatedAt: now() };
        if (await dispatch(engine, { type: "activity.upsert", activity: resolved }, log)) report.activities++;
      }
      if (await dispatch(engine, { type: "turn.settle", turnId: turn.id, status: "error", error: RESTART_ERROR }, log)) {
        report.turns++;
        if (!report.threadIds.includes(turn.threadId)) report.threadIds.push(turn.threadId);
      }
    }
    if (live.length > 0 && queued.length > 0) report.promoted++;
  }
  if (report.turns > 0) log(`[recovery] settled ${report.turns} turn(s) left running by a previous run; ${report.promoted} queued turn(s) resumed`);
  return report;
}

export const CONTINUE_PROMPT = "Continue where you left off.";
/** after this many restart continuations in a row the thread is left alone (a crash loop) */
export const MAX_RESTART_CONTINUATIONS = 3;

/** why a thread must not be nudged after a restart, or undefined when it may be */
function continuationBlocker(model: ReadModel, threadId: string, now: number): string | undefined {
  const thread = model.threads[threadId];
  if (!thread) return "unknown";
  if (thread.archivedAt !== undefined) return "archived";
  if (thread.limited !== undefined) return "limited";
  if (thread.snoozedUntil !== undefined && thread.snoozedUntil > now) return "snoozed";
  if (thread.status === "running") return "already running";
  for (const entry of model.threadTimeline[threadId] ?? []) {
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if ((a?.kind === "approval" || a?.kind === "user-input") && a.status === "pending") return "pending prompt";
  }
  const userMessages = (model.threadMessages[threadId] ?? []).flatMap((id) => {
    const m = model.messages[id];
    return m?.role === "user" ? [m] : [];
  });
  const latest = userMessages.slice(-MAX_RESTART_CONTINUATIONS);
  if (latest.length === MAX_RESTART_CONTINUATIONS && latest.every((m) => m.notification?.source === "restart")) return "restart loop";
  return undefined;
}

/**
 * Opt-in (`continueAfterRestart`): threads whose turn died with the previous process get one
 * "Continue where you left off." turn. Returns how many were sent.
 */
export async function continueAfterRestart(
  engine: Engine,
  threadIds: readonly string[],
  options: Pick<RecoveryOptions, "log" | "now"> = {},
): Promise<number> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  let count = 0;
  for (const threadId of threadIds) {
    const blocker = continuationBlocker(engine.getModel(), threadId, now());
    if (blocker !== undefined) {
      log(`[recovery] thread ${threadId} not continued: ${blocker}`);
      continue;
    }
    const command = {
      type: "turn.request" as const,
      threadId,
      text: CONTINUE_PROMPT,
      notification: { source: "restart" as const, summary: "resumed after a restart" },
    };
    if (await dispatch(engine, command, log)) count++;
  }
  if (count > 0) log(`[recovery] continued ${count} interrupted thread(s)`);
  return count;
}

export const ROLLBACK_RESTART_ERROR = "server restarted during rollback";

/** A rollback the previous process never finished is reported failed, so the thread can be rolled back again. */
export async function recoverRollbacks(engine: Engine, options: Pick<RecoveryOptions, "log"> = {}): Promise<number> {
  const log = options.log ?? (() => undefined);
  let count = 0;
  for (const thread of Object.values(engine.getModel().threads)) {
    if (thread.rollback?.status !== "rolling") continue;
    if (await dispatch(engine, { type: "rollback.report", threadId: thread.id, outcome: "error", error: ROLLBACK_RESTART_ERROR }, log)) count++;
  }
  if (count > 0) log(`[recovery] ${count} rollback(s) interrupted by a restart reported as failed`);
  return count;
}

async function dispatch(
  engine: Engine,
  command: Parameters<Engine["dispatch"]>[0],
  log: (msg: string, data?: unknown) => void,
): Promise<boolean> {
  try {
    await engine.dispatch(command);
    return true;
  } catch (err) {
    log(`[recovery] ${command.type} rejected`, err);
    return false;
  }
}
