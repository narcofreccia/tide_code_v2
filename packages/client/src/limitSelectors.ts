import { limitPhase, type LimitPhase, type ReadModel, type Thread } from "@tide/contracts";

// Threads parked on a harness usage limit (R20: the three phases of Bug C).

/** Threads that hit a usage limit, earliest reset first (unknown reset last). */
export function selectLimited(model: ReadModel): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined && t.limited !== undefined)
    .sort(
      (a, b) =>
        (a.limited?.resetsAt ?? Infinity) - (b.limited?.resetsAt ?? Infinity) || a.id.localeCompare(b.id),
    );
}

/**
 * `limitPhase` for callers that hold only the limit gauges (a status word computed without the
 * whole model). `limitPhase` reads nothing but `model.limits`.
 */
export function limitPhaseOf(model: Pick<ReadModel, "limits"> | undefined, thread: Thread, now: number): LimitPhase | undefined {
  if (thread.limited === undefined) return undefined;
  const gauges: Pick<ReadModel, "limits"> = model?.limits === undefined ? {} : { limits: model.limits };
  return limitPhase(gauges as ReadModel, thread, now);
}

/** Where a limited thread stands and what the user is asked to do; undefined when it is not limited. */
export interface LimitedView {
  phase: LimitPhase;
  policy: "manual" | "reset";
  resetsAt?: number;
  /** the window reopened and the thread waits for the user to continue it */
  needsUser: boolean;
}

export function limitedView(model: Pick<ReadModel, "limits"> | undefined, thread: Thread, now: number): LimitedView | undefined {
  const limited = thread.limited;
  const phase = limitPhaseOf(model, thread, now);
  if (limited === undefined || phase === undefined) return undefined;
  return {
    phase,
    policy: limited.resume,
    ...(limited.resetsAt === undefined ? {} : { resetsAt: limited.resetsAt }),
    needsUser: phase === "ready" && limited.resume === "manual" && thread.archivedAt === undefined,
  };
}

/** True when a limited thread's window reopened and it waits for the user (policy `manual`). */
export function limitNeedsUser(model: Pick<ReadModel, "limits">, thread: Thread, now: number): boolean {
  return limitedView(model, thread, now)?.needsUser === true;
}

/** Limited threads ready to continue by hand, optionally of one project; oldest limit first. */
export function selectLimitReady(model: ReadModel, projectId?: string, now: number = Date.now()): Thread[] {
  return selectLimited(model)
    .filter((t) => projectId === undefined || t.projectId === projectId)
    .filter((t) => limitNeedsUser(model, t, now))
    .sort((a, b) => (a.limited?.at ?? 0) - (b.limited?.at ?? 0) || a.id.localeCompare(b.id));
}
