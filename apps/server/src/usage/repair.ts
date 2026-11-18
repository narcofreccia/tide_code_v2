import type { EventRecord, UsageRepairResult, UsageRepairRow } from "@tide/contracts";
import { RESTART_ERROR, ROLLBACK_RESTART_ERROR, SHUTDOWN_ERROR } from "../orchestration/recovery.ts";

// R20 cost repair. Claude's `total_cost_usd` is cumulative for the session, and a resumed
// process restores the session's saved total (`cost-state` in the transcript). Before the
// driver fix, the first report of every new process was stored as if the whole cumulative
// figure were that turn's cost. This planner finds those reports in the stored events.

/** The idle reaper closes a Claude process after 30 minutes; a later turn runs in a new one. */
export const REOPEN_GAP_MS = 30 * 60_000;
/** cost figures are equal when they differ by less than this (USD) */
export const COST_TOLERANCE = 1e-4;
/** how far back a run of reports is summed when it is compared with the transcript */
const MAX_RUN = 1000;
const RESTART_ERRORS: ReadonlySet<string> = new Set([RESTART_ERROR, SHUTDOWN_ERROR, ROLLBACK_RESTART_ERROR]);

export const REPAIR_REASON = "cost repair: a resumed Claude session reported its cumulative cost as this turn's";

interface TurnFacts {
  id: string;
  threadId: string;
  claude: boolean;
  sessionId?: string;
  startedAt: number;
  settledAt?: number;
  status?: string;
  error?: string;
  /** cost reports in order */
  reports: { usd: number; at: number }[];
  /** the thread ran another turn (another harness or session) or a rollback since this session's previous turn */
  interrupted: boolean;
  corrected: boolean;
}

export interface RepairSession {
  id: string;
  turns: TurnFacts[];
}

export interface RepairScan {
  sessions: RepairSession[];
  /** when a server stopped (its running turns were settled with a restart error) */
  stops: number[];
}

/** Reads the stored events once: every Claude turn grouped by native session, in start order. */
export function scanRepairEvents(records: Iterable<EventRecord>): RepairScan {
  const turns = new Map<string, TurnFacts>();
  const order: TurnFacts[] = [];
  const stops: number[] = [];
  /** per thread: the session of the turn it started last, and whether a rollback came after it */
  const lastOfThread = new Map<string, { sessionId: string | undefined; rolledBack: boolean }>();

  for (const { event } of records) {
    switch (event.type) {
      case "turn.started": {
        const t: TurnFacts = {
          id: event.turnId,
          threadId: event.threadId,
          claude: event.provider === "claude",
          startedAt: event.startedAt,
          reports: [],
          interrupted: false,
          corrected: false,
          ...(event.nativeSessionId !== undefined ? { sessionId: event.nativeSessionId } : {}),
        };
        const prior = lastOfThread.get(event.threadId);
        // the session's previous turn was not the thread's previous one (or a rollback came between): the process was reopened
        if (prior !== undefined && (prior.rolledBack || (t.sessionId !== undefined && prior.sessionId !== t.sessionId))) t.interrupted = true;
        turns.set(t.id, t);
        order.push(t);
        lastOfThread.set(event.threadId, { sessionId: t.claude ? t.sessionId : `other:${event.provider}`, rolledBack: false });
        break;
      }
      case "turn.session-identified": {
        const t = turns.get(event.turnId);
        if (t) {
          t.sessionId = event.nativeSessionId;
          const prior = lastOfThread.get(event.threadId);
          if (prior && t.claude) prior.sessionId = event.nativeSessionId;
        }
        break;
      }
      case "usage.reported": {
        const cost = event.usage?.costUsd;
        if (cost !== undefined) turns.get(event.turnId)?.reports.push({ usd: cost, at: event.at });
        break;
      }
      case "usage.corrected": {
        const t = turns.get(event.turnId);
        if (t) t.corrected = true;
        break;
      }
      case "turn.settled": {
        const t = turns.get(event.turnId);
        if (t) {
          t.settledAt = event.settledAt;
          t.status = event.status;
          if (event.error !== undefined) t.error = event.error;
        }
        if (event.error !== undefined && RESTART_ERRORS.has(event.error)) stops.push(event.settledAt);
        break;
      }
      case "rollback.completed": {
        const prior = lastOfThread.get(event.threadId);
        if (prior) prior.rolledBack = true;
        break;
      }
    }
  }

  const sessions = new Map<string, RepairSession>();
  for (const t of order) {
    if (!t.claude || t.sessionId === undefined) continue;
    let s = sessions.get(t.sessionId);
    if (!s) sessions.set(t.sessionId, (s = { id: t.sessionId, turns: [] }));
    s.turns.push(t);
  }
  return { sessions: [...sessions.values()], stops };
}

/** The turn runs in a process other than its session's previous turn's. */
function reopened(prev: TurnFacts | undefined, turn: TurnFacts, stops: readonly number[]): boolean {
  if (prev === undefined) return false;
  if (turn.interrupted || prev.status === "error" || (prev.error !== undefined && RESTART_ERRORS.has(prev.error))) return true;
  const ended = prev.settledAt ?? prev.startedAt;
  if (turn.startedAt - ended > REOPEN_GAP_MS) return true;
  return stops.some((at) => at >= ended && at <= turn.startedAt);
}

export interface PlannedRow extends UsageRepairRow {
  sessionId: string;
}

export interface PlanInput {
  scan: RepairScan;
  /** cost-state totals of each session's transcript, in file order; absent = no transcript */
  costStates: ReadonlyMap<string, readonly number[]>;
  titleOf?: (threadId: string) => string | undefined;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= COST_TOLERANCE;
const round = (n: number): number => Math.round(n * 1e8) / 1e8;

/**
 * Walks each session's cost reports keeping the session's running total as Claude counts it
 * (the chain: since its last cumulative report). A turn's first report is cumulative when
 *  - transcript: the reports just before it sum to a `cost-state` total (so a process ended
 *    there and saved that total) and it is at least that total; or the session was reopened,
 *    it equals a `cost-state` total and is at least the chain;
 *  - heuristic (no transcript found): the session was reopened (a gap over 30 minutes,
 *    an error, a server stop, a rollback, another harness in between) and it is at least the chain.
 * Its corrected cost is the value minus that base. A first turn of a session has no base,
 * so an honest expensive first turn is never touched.
 */
export function planRepair(input: PlanInput): PlannedRow[] {
  const rows: PlannedRow[] = [];
  for (const session of input.scan.sessions) {
    const totals = input.costStates.get(session.id);
    const isTotal = (x: number): boolean => totals !== undefined && totals.some((c) => near(c, x));
    /** corrected values since the chain's start (the last cumulative report counts whole) */
    let run: number[] = [];
    let prev: TurnFacts | undefined;
    for (const turn of session.turns) {
      const reopen = reopened(prev, turn, input.scan.stops);
      prev = turn;
      turn.reports.forEach((report, i) => {
        const v = report.usd;
        let base: number | undefined;
        let evidence: UsageRepairRow["evidence"] | undefined;
        // a process starts with a turn: only a turn's first report can carry a restored total
        if (i === 0 && run.length > 0) {
          const chain = run.reduce((a, b) => a + b, 0);
          if (totals !== undefined) {
            let sum = 0;
            for (let k = run.length - 1; k >= Math.max(0, run.length - MAX_RUN); k--) {
              sum += run[k] as number;
              if (sum > 0 && sum <= v + COST_TOLERANCE && isTotal(sum) && (base === undefined || sum > base)) base = sum;
            }
            if (base === undefined && reopen && chain > 0 && v >= chain && isTotal(v)) base = chain;
            if (base !== undefined) evidence = "transcript";
          } else if (reopen && chain > 0 && v >= chain) {
            // only without a transcript: one that confirms nothing outranks the inference
            base = chain;
            evidence = "heuristic";
          }
        }
        if (base === undefined || evidence === undefined) {
          run.push(v);
          return;
        }
        run = [v];
        const stored = turn.reports.reduce((a, r) => a + r.usd, 0);
        rows.push({
          sessionId: session.id,
          threadId: turn.threadId,
          threadTitle: input.titleOf?.(turn.threadId) ?? turn.threadId,
          turnId: turn.id,
          at: report.at,
          storedUsd: round(stored),
          correctedUsd: round(stored - Math.min(base, v)),
          evidence,
          applied: turn.corrected,
        });
      });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

export function repairTotals(rows: readonly UsageRepairRow[], appliedCount = 0): UsageRepairResult {
  return {
    rows: rows.map(({ threadId, threadTitle, turnId, at, storedUsd, correctedUsd, evidence, applied }) => ({ threadId, threadTitle, turnId, at, storedUsd, correctedUsd, evidence, applied })),
    storedUsd: round(rows.reduce((a, r) => a + r.storedUsd, 0)),
    correctedUsd: round(rows.reduce((a, r) => a + r.correctedUsd, 0)),
    appliedCount,
  };
}
