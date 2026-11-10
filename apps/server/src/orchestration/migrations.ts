import type { Database } from "../db/sqlite.ts";

/**
 * On-disk schema of the event store, tracked with `PRAGMA user_version`.
 *
 * Each entry upgrades the database from `version - 1` to `version`; they run in order, all in
 * one transaction, at open. Never edit a shipped entry: add the next one. Version 1 is the
 * schema that existed before versioning (every statement is `IF NOT EXISTS`), so a database
 * that predates versioning (user_version 0 with the tables already there) is adopted as 1.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; up: (db: Database) => void }> = [
  {
    version: 1,
    up: (db) =>
      db.exec(`
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
`),
  },
  {
    // read-model snapshots: boot replays only the events after the newest usable one
    version: 2,
    up: (db) => db.exec("CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, schema INTEGER NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL);"),
  },
  {
    // delta compaction: a merged run lives at first_seq and replaced the rows up to last_seq
    version: 3,
    up: (db) =>
      db.exec(`
CREATE TABLE IF NOT EXISTS compacted_spans (first_seq INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS compacted_spans_last_idx ON compacted_spans(last_seq);
`),
  },
];

export const STORE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** The database was written by a newer server; opening it would risk rewriting data this build does not understand. */
export class StoreSchemaError extends Error {
  readonly found: number;
  constructor(found: number) {
    super(`this data was written by a newer Tide (schema ${found}, this server knows ${STORE_SCHEMA_VERSION}); update this server or restore a backup`);
    this.name = "StoreSchemaError";
    this.found = found;
  }
}

export function schemaVersion(db: Database): number {
  return Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
}

/** Brings `db` to {@link STORE_SCHEMA_VERSION}; throws {@link StoreSchemaError} when it is already past it. */
export function migrate(db: Database, migrations = MIGRATIONS): void {
  const target = migrations[migrations.length - 1]?.version ?? 0;
  const found = schemaVersion(db);
  if (found > target) throw new StoreSchemaError(found);
  if (found === target) return;
  db.transaction(() => {
    for (const m of migrations) {
      if (m.version <= found) continue;
      m.up(db);
      // user_version is part of the database header, so it commits or rolls back with the rest
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
    }
  });
}
