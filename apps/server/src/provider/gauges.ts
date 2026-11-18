import { threadInstanceId, type NormalizedEvent, type RateLimit, type ReadModel } from "@tide/contracts";

type UsageReport = Omit<Extract<NormalizedEvent, { type: "usage" }>, "type">;

/**
 * The instance gauge a windowed report would overwrite, keyed like the decider stamps
 * `usage.reported.providerId`: the turn's own instance, else its thread's.
 */
export function knownGauge(model: ReadModel, turnId: string, rateLimit: RateLimit | undefined): RateLimit | undefined {
  if (rateLimit?.window === undefined) return undefined;
  const turn = model.turns[turnId];
  const thread = turn !== undefined ? model.threads[turn.threadId] : undefined;
  const instance = turn?.providerId ?? turn?.provider ?? (thread !== undefined ? threadInstanceId(thread) : undefined);
  return instance !== undefined ? model.limits?.[instance]?.[rateLimit.window] : undefined;
}

const pct = (value: number | undefined): number | undefined => (value === undefined ? undefined : Math.round(value));

/**
 * R20: harnesses send a rate-limit frame with every request, and a frame now becomes one report
 * per window. A report carrying only a windowed gauge that says nothing new against the stored
 * one is noise in the event log. Usage, context usage and windowless (overage) reports always
 * go through; so does a first `limited`, since the stored gauge then has another status.
 */
export function isRedundantGauge(report: UsageReport, known: RateLimit | undefined): boolean {
  const next = report.rateLimit;
  if (report.usage !== undefined || report.contextUsage !== undefined) return false;
  if (next?.window === undefined || known === undefined) return false;
  return (
    next.status === known.status &&
    pct(next.remainingPct) === pct(known.remainingPct) &&
    next.resetsAt === known.resetsAt &&
    next.overage === known.overage
  );
}
