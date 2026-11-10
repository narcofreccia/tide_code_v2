import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { MIGRATIONS, STORE_SCHEMA_VERSION, StoreSchemaError, migrate, schemaVersion } from "./migrations.ts";
import { EventStore } from "./store.ts";

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, aggregate_id TEXT, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events(aggregate_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS receipts (command_id TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, ts INTEGER NOT NULL);
`;

describe("store schema version", () => {
  it("creates a fresh database at the current version", async () => {
    const db = await openDatabase(":memory:");
    new EventStore(db);
    expect(schemaVersion(db)).toBe(STORE_SCHEMA_VERSION);
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });

  it("adopts a pre-versioning database (user_version 0, tables present) and keeps its rows", async () => {
    const db = await openDatabase(":memory:");
    db.exec(LEGACY_SCHEMA);
    db.prepare("INSERT INTO events (ts, type, aggregate_id, payload) VALUES (?, ?, ?, ?)").run(
      1,
      "project.created",
      "p1",
      JSON.stringify({ type: "project.created", project: { id: "p1" } }),
    );
    db.prepare("INSERT INTO meta (key, value) VALUES ('environmentId', 'env-1')").run();
    expect(schemaVersion(db)).toBe(0);
    const store = new EventStore(db);
    expect(schemaVersion(db)).toBe(STORE_SCHEMA_VERSION);
    expect(store.lastSeq()).toBe(1);
    expect(store.getMeta("environmentId")).toBe("env-1");
    // and is a no-op the second time
    new EventStore(db);
    expect(store.lastSeq()).toBe(1);
  });

  it("refuses a database written by a newer server, with a sentence that says what to do", async () => {
    const db = await openDatabase(":memory:");
    db.exec("PRAGMA user_version = 99");
    let err: unknown;
    try {
      new EventStore(db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreSchemaError);
    expect((err as Error).message).toContain("this data was written by a newer Tide (schema 99");
    expect((err as Error).message).toContain("update this server or restore a backup");
    // nothing was touched
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });

  it("runs the pending steps in one transaction: a failing step leaves the old version", async () => {
    const db = await openDatabase(":memory:");
    migrate(db, MIGRATIONS.slice(0, 1));
    expect(schemaVersion(db)).toBe(1);
    const broken = [
      ...MIGRATIONS.slice(0, 1),
      { version: 2, up: (d: typeof db) => d.exec("CREATE TABLE half_done (x INTEGER)") },
      {
        version: 3,
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() => migrate(db, broken)).toThrow("boom");
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
  });
});
