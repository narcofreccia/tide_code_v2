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
`;

/** The aggregate an event belongs to, used for cheap per-entity queries later. */
export function aggregateIdOf(event: DomainEvent): string | null {
  switch (event.type) {
    case "project.created":
      return event.project.id;
    case "project.updated":
    case "project.archived":
      return event.projectId;
    case "thread.created":
      return event.thread.id;
    case "thread.updated":
    case "thread.archived":
    case "thread.status-changed":
      return event.threadId;
    case "turn.requested":
      return event.turn.threadId;
    case "turn.started":
    case "turn.interrupt-requested":
    case "assistant.delta":
    case "approval.responded":
    case "user-input.responded":
    case "plan.progressed":
    case "usage.reported":
    case "turn.settled":
      return event.threadId;
    case "activity.upserted":
      return event.activity.threadId;
    case "plan.proposed":
      return event.plan.threadId;
    case "plan.updated":
      return event.planId;
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
  }

  /** Appends all events atomically and returns them with their assigned seq. */
  append(events: DomainEvent[], ts: number): EventRecord[] {
    if (events.length === 0) return [];
    return this.#db.transaction(() => {
      const out: EventRecord[] = [];
      for (const event of events) {
        const row = this.#insert.get(ts, event.type, aggregateIdOf(event), JSON.stringify(event));
        out.push({ seq: Number(row?.["seq"]), ts, event });
      }
      return out;
    });
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

  close(): void {
    this.#db.close();
  }
}

export async function openEventStore(path: string): Promise<EventStore> {
  return new EventStore(await openDatabase(path));
}
