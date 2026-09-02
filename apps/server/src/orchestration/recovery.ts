import type { Activity, ActivityOf, ReadModel, Turn } from "@tide/contracts";
import type { Engine } from "./engine.ts";

export const RESTART_ERROR = "server restarted while this turn was running";
export const SHUTDOWN_ERROR = "server shutting down";

export interface RecoveryOptions {
  log?: (msg: string, data?: unknown) => void;
  now?: () => number;
}

export interface RecoveryReport {
  turns: number;
  activities: number;
}

/** Turns the harness may still have been working on when the process went away. */
export function unsettledTurns(model: ReadModel): Turn[] {
  return Object.values(model.turns)
    .filter((turn) => turn.status === "requested" || turn.status === "running")
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
 * forever and every later `turn.request` / `thread.revert` is rejected as `busy`.
 *
 * Runs right after the engine replays and *before* any reactor subscribes, so the synthetic
 * settles never reach the provider or vcs reactors.
 */
export async function recoverUnsettledTurns(engine: Engine, options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const model = engine.getModel();
  const report: RecoveryReport = { turns: 0, activities: 0 };

  for (const turn of unsettledTurns(model)) {
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
    }
  }
  if (report.turns > 0) log(`[recovery] settled ${report.turns} turn(s) left running by a previous run`);
  return report;
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
