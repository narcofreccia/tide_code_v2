import type { DomainEvent, EventRecord } from "@tide/contracts";
import { openDatabase, type Database, type SqlStatement } from "../db/sqlite.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  aggregate_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events(aggregate_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS receipts (command_id TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, ts INTEGER NOT NULL);
`;

/** The aggregate an event belongs to, used for cheap per-entity queries later. */
export function aggregateIdOf(event: DomainEvent): string | null {
  switch (event.type) {
    case "project.created":
      return event.project.id;
    case "project.updated":
    case "project.archived":
    case "project.link.added":
    case "project.runStack.changed":
    case "project.link.updated":
    case "project.link.removed":
      return event.projectId;
    case "thread.created":
      return event.thread.id;
    case "thread.updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return event.threadId;
    case "project.unarchived":
      return event.projectId;
    case "turn.requested":
      return event.turn.threadId;
    case "turn.started":
    case "turn.dequeued":
    case "turn.interrupt-requested":
    case "assistant.delta":
    case "assistant.reasoning-delta":
    case "approval.responded":
    case "user-input.responded":
    case "plan.progressed":
    case "usage.reported":
    case "turn.settled":
    case "worktree.attached":
    case "checkpoint.recorded":
    case "worktree.detach-requested":
    case "worktree.detached":
    case "publish.requested":
    case "merge.requested":
    case "merge.completed":
    case "merge.conflicted":
    case "merge.failed":
    case "thread.triaged":
    case "pr.updated":
    case "turn.steered":
    case "turn.steer-fell-back":
    case "turn.edited":
    case "turns.reordered":
    case "handoff.delivered":
    case "rollback.requested":
    case "rollback.completed":
    case "rollback.failed":
    case "thread.limited":
    case "thread.limit-policy-changed":
    case "thread.snoozed":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.resumed":
    case "pr.watch-changed":
    case "handoff.refined":
      return event.threadId;
    case "judge.recorded":
      return event.target.id;
    case "handoff.recorded":
      return event.handoff.threadId;
    case "task.created":
      return event.task.id;
    case "task.updated":
    case "task.deleted":
    case "task.fired":
      return event.taskId;
    case "activity.upserted":
      return event.activity.threadId;
    case "plan.proposed":
      return event.plan.threadId;
    case "plan.updated":
      return event.planId;
    case "experts.created":
      return event.session.id;
    case "experts.threads-bound":
    case "experts.phase-changed":
    case "experts.expert-status-changed":
    case "experts.synthesis-set":
    case "experts.archived":
      return event.sessionId;
    case "experts.finding-posted":
      return event.finding.sessionId;
    case "experts.message-posted":
      return event.message.sessionId;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

function toRecord(row: Record<string, unknown>): EventRecord {
  return {
    seq: Number(row["seq"]),
    ts: Number(row["ts"]),
    event: JSON.parse(String(row["payload"])) as DomainEvent,
  };
}

export class EventStore {
  #db: Database;
  #insert: SqlStatement;
  #readFrom: SqlStatement;
  #readAll: SqlStatement;
  #last: SqlStatement;
  #getMeta: SqlStatement;
  #setMeta: SqlStatement;
  #getReceipt: SqlStatement;
  #putReceipt: SqlStatement;
  #readRange: SqlStatement;

  constructor(db: Database) {
    this.#db = db;
    db.exec(SCHEMA);
    this.#insert = db.prepare(
      "INSERT INTO events (ts, type, aggregate_id, payload) VALUES (?, ?, ?, ?) RETURNING seq",
    );
    this.#readFrom = db.prepare("SELECT seq, ts, payload FROM events WHERE seq >= ? ORDER BY seq ASC");
    this.#readAll = db.prepare("SELECT seq, ts, payload FROM events ORDER BY seq ASC");
    this.#last = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events");
    this.#getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
    this.#setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.#getReceipt = db.prepare("SELECT first_seq, last_seq, ts FROM receipts WHERE command_id = ?");
    this.#putReceipt = db.prepare("INSERT OR IGNORE INTO receipts (command_id, first_seq, last_seq, ts) VALUES (?, ?, ?, ?)");
    this.#readRange = db.prepare("SELECT seq, ts, payload FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq ASC");
  }

  /**
   * Appends all events atomically and returns them with their assigned seq. With `receipt`, the
   * command receipt is written in the same transaction (0/0 when there are no events).
   */
  append(events: DomainEvent[], ts: number, receipt?: { commandId: string }): EventRecord[] {
    if (events.length === 0 && receipt === undefined) return [];
    return this.#db.transaction(() => {
      const out: EventRecord[] = [];
      for (const event of events) {
        const row = this.#insert.get(ts, event.type, aggregateIdOf(event), JSON.stringify(event));
        out.push({ seq: Number(row?.["seq"]), ts, event });
      }
      if (receipt !== undefined) {
        this.#putReceipt.run(receipt.commandId, out[0]?.seq ?? 0, out[out.length - 1]?.seq ?? 0, ts);
      }
      return out;
    });
  }

  getReceipt(commandId: string): { firstSeq: number; lastSeq: number; ts: number } | undefined {
    const row = this.#getReceipt.get(commandId);
    if (row === undefined) return undefined;
    return { firstSeq: Number(row["first_seq"]), lastSeq: Number(row["last_seq"]), ts: Number(row["ts"]) };
  }

  readRange(firstSeq: number, lastSeq: number): EventRecord[] {
    if (firstSeq === 0) return [];
    return this.#readRange.all(firstSeq, lastSeq).map(toRecord);
  }

  readFrom(seq: number): EventRecord[] {
    return this.#readFrom.all(seq).map(toRecord);
  }

  readAll(): EventRecord[] {
    return this.#readAll.all().map(toRecord);
  }

  lastSeq(): number {
    return Number(this.#last.get()?.["seq"] ?? 0);
  }

  getMeta(key: string): string | undefined {
    const row = this.#getMeta.get(key);
    return row === undefined ? undefined : String(row["value"]);
  }

  setMeta(key: string, value: string): void {
    this.#setMeta.run(key, value);
  }

  /**
   * Non-event side tables (observability such as the judge ledger) share this connection: runs
   * `ddl` (idempotent CREATE ... IF NOT EXISTS) and returns statement access. Side tables never
   * feed the projector.
   */
  sideTable(ddl: string): Pick<Database, "prepare" | "exec"> {
    this.#db.exec(ddl);
    return { prepare: (sql) => this.#db.prepare(sql), exec: (sql) => this.#db.exec(sql) };
  }

  close(): void {
    this.#db.close();
  }
}

export async function openEventStore(path: string): Promise<EventStore> {
  return new EventStore(await openDatabase(path));
}
