import type { TimelineItem } from "@tide/client";
import type { Turn } from "@tide/contracts";

function turnOf(entry: TimelineItem): string {
  if (entry.kind === "message") return entry.message.turnId;
  if (entry.kind === "activity") return entry.activity.turnId;
  return entry.plan.turnId;
}

/**
 * The stream grouped by turn. The raw timeline is in log order, so a message
 * queued while a turn ran sits among that turn's later activities; here every
 * turn's entries stay together (timeline order inside a turn) and turns follow
 * `turns` (oldest request first). An entry whose turn the model does not know
 * stays right after the turn it followed.
 */
export function orderByTurn(entries: readonly TimelineItem[], turns: readonly Turn[]): TimelineItem[] {
  const rank = new Map(turns.map((turn, i) => [turn.id, i] as const));
  const buckets = new Map<string, TimelineItem[]>();
  for (const entry of entries) {
    const key = turnOf(entry);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  let last = -1;
  const keyed = [...buckets.keys()].map((key, seen) => {
    const known = rank.get(key);
    if (known !== undefined) last = known;
    return { key, rank: known ?? last + 0.5, seen };
  });
  keyed.sort((a, b) => a.rank - b.rank || a.seen - b.seen);
  return keyed.flatMap(({ key }) => buckets.get(key) ?? []);
}

/**
 * Turns that were requested while an earlier turn was still running: they waited
 * in the queue, so their user message keeps a "queued" tag after they ran.
 */
export function queuedTurnIds(turns: readonly Turn[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < turns.length; i += 1) {
    const turn = turns[i];
    const previous = turns[i - 1];
    if (!turn || !previous) continue;
    const waited =
      previous.settledAt === undefined
        ? previous.status === "requested" || previous.status === "running" || previous.status === "queued"
        : turn.requestedAt < previous.settledAt;
    if (waited) out.add(turn.id);
  }
  return out;
}
