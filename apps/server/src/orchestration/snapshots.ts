import type { ReadModel } from "@tide/contracts";
import type { Database, SqlStatement } from "../db/sqlite.ts";

/**
 * Version of what a stored read model means. Bump it on ANY change to how events project
 * (projector cases in `@tide/contracts`, the ReadModel shape, a new event type): old snapshots
 * then stop matching and boot falls back to a full replay, which rebuilds the right model and
 * writes a fresh snapshot on the next shutdown. Forgetting a bump means a stale model.
 */
export const MODEL_SCHEMA = 1;
/**
 * sha256 of the `ReadModel` TypeBox schema (sorted keys, annotations dropped) that MODEL_SCHEMA
 * describes. `snapshotSchema.test.ts` fails when the schema's shape changes and prints the new
 * value: bump MODEL_SCHEMA and paste it here.
 */
export const MODEL_SCHEMA_HASH = "d4f44c1fbb556f0b8b20a2d5aa05ecbf16f80044761c14d09e664c1ed5c78cba";

/** How many snapshots are kept; an older one is the fallback when the newest does not parse. */
const KEEP = 2;

export interface LoadedSnapshot {
  seq: number;
  model: ReadModel;
}

/** The `snapshots` table: read models serialised at a seq, newest first. */
export class SnapshotTable {
  #put: SqlStatement;
  #prune: SqlStatement;
  #list: SqlStatement;
  #dropInside: SqlStatement;
  #latestSeq: SqlStatement;

  constructor(db: Database) {
    this.#put = db.prepare("INSERT OR REPLACE INTO snapshots (seq, schema, model, created_at) VALUES (?, ?, ?, ?)");
    this.#prune = db.prepare(`DELETE FROM snapshots WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT ${KEEP})`);
    this.#list = db.prepare("SELECT seq, model FROM snapshots WHERE schema = ? ORDER BY seq DESC");
    this.#dropInside = db.prepare("DELETE FROM snapshots WHERE seq >= ? AND seq < ?");
    this.#latestSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM snapshots");
  }

  /** Stores `json` (the serialised model at `seq`) and drops all but the newest {@link KEEP}. Returns its size. */
  write(seq: number, json: string, now: number, schema = MODEL_SCHEMA): number {
    this.#put.run(seq, schema, json, now);
    this.#prune.run();
    return json.length;
  }

  latestSeq(): number {
    return Number(this.#latestSeq.get()?.["seq"] ?? 0);
  }

  /**
   * Newest snapshot of `schema` that parses and is not ahead of the log; a corrupt one is
   * reported through `warn` and skipped for the next older.
   */
  load(maxSeq: number, warn: (msg: string) => void, schema = MODEL_SCHEMA): LoadedSnapshot | undefined {
    for (const row of this.#list.all(schema)) {
      const seq = Number(row["seq"]);
      if (seq > maxSeq) {
        warn(`[store] snapshot at seq ${seq} is ahead of the log (last seq ${maxSeq}); ignored`);
        continue;
      }
      try {
        const model = JSON.parse(String(row["model"])) as ReadModel;
        if (typeof model !== "object" || model === null || model.seq !== seq || typeof model.threads !== "object") throw new Error("not a read model");
        return { seq, model };
      } catch (err) {
        warn(`[store] snapshot at seq ${seq} is unreadable (${err instanceof Error ? err.message : String(err)}); falling back`);
      }
    }
    return undefined;
  }

  /** Snapshots taken inside [first, last) saw part of a run that compaction just merged: they cannot be resumed from. */
  dropInside(first: number, last: number): void {
    this.#dropInside.run(first, last);
  }
}
