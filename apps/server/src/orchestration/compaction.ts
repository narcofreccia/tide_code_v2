import type { DomainEvent, EventRecord } from "@tide/contracts";
import type { Database, SqlStatement } from "../db/sqlite.ts";

/*
 * Delta compaction: a settled turn's streamed text lives in the log as one row per chunk.
 * Afterwards those rows are rewritten into one row per run, stored at the seq of the run's
 * first chunk, and the rest are deleted.
 *
 * The rule (per thread, i.e. per aggregate_id, in seq order):
 *   - a run is the `assistant.delta` (or, separately, `assistant.reasoning-delta`) events of one
 *     (turnId, messageId) of a SETTLED turn;
 *   - a run continues across other deltas of the same thread (other messages, or the other kind of
 *     delta of the same message) and across `activity.upserted`: none of them reads or replaces
 *     a message's text/reasoning (the projector writes `text` only from `assistant.delta` and
 *     `turn.edited`, `reasoning` only from `assistant.reasoning-delta`);
 *   - every other event of the thread ends every open run (turn.settled, turn.edited,
 *     turn.steered, turn.dequeued, thread.deleted… can create, drop or overwrite messages);
 *     so does a delta of a turn that is not settled;
 *   - events of other aggregates never touch this thread's messages and are ignored.
 * Why the merged row projects identically: the projector appends `delta` to the field of its
 * kind, and the first event of each kind for a message is still first at the same seq, so the
 * message is created by the same event with the same `at`, at the same timeline position;
 * every later chunk only appended to that field. The model at any seq >= the run's last chunk
 * is therefore unchanged; only models at seqs inside [first, last) differ, and those are
 * exactly what `compacted_spans` records (catch-up from inside one gets a snapshot, and stored
 * snapshots inside one are dropped).
 */

type Delta = Extract<DomainEvent, { type: "assistant.delta" | "assistant.reasoning-delta" }>;
const isDelta = (e: DomainEvent): e is Delta => e.type === "assistant.delta" || e.type === "assistant.reasoning-delta";

export interface CompactionPlan {
  /** merged records, at the seq of their run's first chunk */
  rewrites: EventRecord[];
  /** seqs of the chunks folded into a rewrite */
  deletes: number[];
  /** [first, last] seq of each merged run */
  spans: Array<[number, number]>;
  /** first seq of a delta left alone because its turn is still running */
  deferredFrom?: number;
}

/** Plans the merges for ONE aggregate's records (seq order). Pure. */
export function planCompaction(records: readonly EventRecord[], isSettled: (turnId: string) => boolean): CompactionPlan {
  const plan: CompactionPlan = { rewrites: [], deletes: [], spans: [] };
  const open = new Map<string, EventRecord[]>();
  const close = (): void => {
    for (const run of open.values()) {
      const first = run[0];
      const last = run[run.length - 1];
      if (first === undefined || last === undefined || run.length < 2) continue;
      const head = first.event as Delta;
      plan.rewrites.push({ seq: first.seq, ts: first.ts, event: { ...head, delta: run.map((r) => (r.event as Delta).delta).join("") } });
      for (const r of run.slice(1)) plan.deletes.push(r.seq);
      plan.spans.push([first.seq, last.seq]);
    }
    open.clear();
  };
  for (const record of records) {
    const event = record.event;
    if (isDelta(event)) {
      if (!isSettled(event.turnId)) {
        if (plan.deferredFrom === undefined) plan.deferredFrom = record.seq;
        close();
        continue;
      }
      const key = `${event.type}\u0000${event.turnId}\u0000${event.messageId}`;
      const run = open.get(key);
      if (run) run.push(record);
      else open.set(key, [record]);
      continue;
    }
    if (event.type === "activity.upserted") continue;
    close();
  }
  close();
  return plan;
}

export interface CompactionStats {
  runs: number;
  deleted: number;
}

const WATERMARK = "compacted_through_seq";

/** SQL side of compaction; owned by the EventStore so it shares its connection. */
export class CompactionTable {
  #db: Database;
  #after: SqlStatement;
  #aggregateAfter: SqlStatement;
  #rewrite: SqlStatement;
  #delete: SqlStatement;
  #span: SqlStatement;
  #inside: SqlStatement;
  #getMeta: SqlStatement;
  #setMeta: SqlStatement;
  #dropSnapshots: SqlStatement;

  constructor(db: Database) {
    this.#db = db;
    this.#after = db.prepare("SELECT seq, ts, aggregate_id, payload FROM events WHERE seq > ? ORDER BY seq ASC");
    this.#aggregateAfter = db.prepare("SELECT seq, ts, payload FROM events WHERE aggregate_id = ? AND seq > ? ORDER BY seq ASC");
    this.#rewrite = db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    this.#delete = db.prepare("DELETE FROM events WHERE seq = ?");
    this.#span = db.prepare(
      "INSERT INTO compacted_spans (first_seq, last_seq) VALUES (?, ?) ON CONFLICT(first_seq) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)",
    );
    this.#inside = db.prepare("SELECT 1 AS hit FROM compacted_spans WHERE last_seq > ? AND first_seq <= ? LIMIT 1");
    this.#getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
    this.#setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.#dropSnapshots = db.prepare("DELETE FROM snapshots WHERE seq >= ? AND seq < ?");
  }

  /** True when a client whose model is at `seq` saw only part of a run that was merged since. */
  inside(seq: number): boolean {
    return this.#inside.get(seq, seq) !== undefined;
  }

  watermark(): number {
    return Number(this.#getMeta.get(WATERMARK)?.["value"] ?? 0);
  }

  /** Every aggregate's records after `seq`, grouped by aggregate (rows without one are skipped). */
  groupedAfter(seq: number): { groups: Map<string, EventRecord[]>; lastSeq: number } {
    const groups = new Map<string, EventRecord[]>();
    let lastSeq = seq;
    for (const row of this.#after.all(seq)) {
      const record = toRecord(row);
      lastSeq = record.seq;
      const aggregate = row["aggregate_id"];
      if (typeof aggregate !== "string") continue;
      const list = groups.get(aggregate);
      if (list) list.push(record);
      else groups.set(aggregate, [record]);
    }
    return { groups, lastSeq };
  }

  aggregateAfter(aggregateId: string, seq: number): EventRecord[] {
    return this.#aggregateAfter.all(aggregateId, seq).map(toRecord);
  }

  /** Applies plans atomically (rows, spans, stale snapshots, and the watermark when given). */
  apply(plans: readonly CompactionPlan[], watermark?: number): CompactionStats {
    const stats: CompactionStats = { runs: 0, deleted: 0 };
    this.#db.transaction(() => {
      for (const plan of plans) {
        for (const r of plan.rewrites) this.#rewrite.run(JSON.stringify(r.event), r.seq);
        for (const seq of plan.deletes) this.#delete.run(seq);
        for (const [first, last] of plan.spans) {
          this.#span.run(first, last);
          this.#dropSnapshots.run(first, last);
        }
        stats.runs += plan.rewrites.length;
        stats.deleted += plan.deletes.length;
      }
      if (watermark !== undefined && watermark > this.watermark()) this.#setMeta.run(WATERMARK, String(watermark));
    });
    return stats;
  }

  /** Folds the WAL back into the main file after a large rewrite (never VACUUM: that rewrites the whole file). */
  checkpoint(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}

function toRecord(row: Record<string, unknown>): EventRecord {
  return { seq: Number(row["seq"]), ts: Number(row["ts"]), event: JSON.parse(String(row["payload"])) as DomainEvent };
}

/** After this many deleted rows a pass also checkpoints the WAL. */
const CHECKPOINT_AFTER = 10_000;

/**
 * Runs compaction against a store. `isSettled` answers from the engine's model: a turn that no
 * longer exists counts as settled (its thread was deleted or it was dequeued; its rows are
 * history either way).
 */
export class Compactor {
  #table: CompactionTable;
  #isSettled: (turnId: string) => boolean;

  constructor(table: CompactionTable, isSettled: (turnId: string) => boolean) {
    this.#table = table;
    this.#isSettled = isSettled;
  }

  /** One thread, from the watermark on: what runs when one of its turns settles. */
  thread(threadId: string): CompactionStats {
    const plan = planCompaction(this.#table.aggregateAfter(threadId, this.#table.watermark()), this.#isSettled);
    if (plan.rewrites.length === 0) return { runs: 0, deleted: 0 };
    return this.#table.apply([plan]);
  }

  /** Everything after the watermark; advances it up to the first delta of a still-running turn. */
  all(): CompactionStats {
    const from = this.#table.watermark();
    const { groups, lastSeq } = this.#table.groupedAfter(from);
    const plans: CompactionPlan[] = [];
    let deferred = Number.POSITIVE_INFINITY;
    for (const records of groups.values()) {
      const plan = planCompaction(records, this.#isSettled);
      if (plan.deferredFrom !== undefined) deferred = Math.min(deferred, plan.deferredFrom);
      if (plan.rewrites.length > 0) plans.push(plan);
    }
    const watermark = Number.isFinite(deferred) ? deferred - 1 : lastSeq;
    const stats = this.#table.apply(plans, watermark);
    if (stats.deleted >= CHECKPOINT_AFTER) this.#table.checkpoint();
    return stats;
  }
}
