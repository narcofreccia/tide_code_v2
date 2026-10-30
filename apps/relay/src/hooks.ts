import { DatabaseSync } from "node:sqlite";
import type { Headers } from "./protocol.ts";

/** A webhook the relay holds while its environment is offline. */
export interface StoredHook {
  seq: number;
  id: string;
  envId: string;
  hookId: string;
  headers: Headers;
  body: Buffer;
  receivedAt: number;
}

export const HOOK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * SQLite-backed queue of undelivered webhooks plus the delivery ids already seen
 * (`X-Tide-Delivery`), both kept for 24 h. Bodies are stored, never logged.
 */
export class HookStore {
  #db: DatabaseSync;
  #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS hooks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, env TEXT NOT NULL, hook TEXT NOT NULL,
        headers TEXT NOT NULL, body BLOB NOT NULL, received_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hooks_env ON hooks(env, seq);
      CREATE TABLE IF NOT EXISTS deliveries (env TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (env, id));
    `);
  }

  /** true when this delivery id was already accepted for the environment (and records it otherwise). */
  seen(envId: string, deliveryId: string): boolean {
    const row = this.#db.prepare("SELECT at FROM deliveries WHERE env = ? AND id = ?").get(envId, deliveryId) as { at: number } | undefined;
    if (row !== undefined && row.at > this.#now() - HOOK_TTL_MS) return true;
    this.#db.prepare("INSERT OR REPLACE INTO deliveries (env, id, at) VALUES (?, ?, ?)").run(envId, deliveryId, this.#now());
    return false;
  }

  /** Forgets a delivery id, so a sender's retry is accepted after a failed hand-off. */
  unsee(envId: string, deliveryId: string): void {
    this.#db.prepare("DELETE FROM deliveries WHERE env = ? AND id = ?").run(envId, deliveryId);
  }

  put(hook: Omit<StoredHook, "seq">): void {
    this.#db
      .prepare("INSERT INTO hooks (id, env, hook, headers, body, received_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hook.id, hook.envId, hook.hookId, JSON.stringify(hook.headers), hook.body, hook.receivedAt);
  }

  /** Oldest undelivered hook for the environment that is still within its 24 h window. */
  next(envId: string): StoredHook | undefined {
    this.prune();
    const row = this.#db.prepare("SELECT * FROM hooks WHERE env = ? ORDER BY seq LIMIT 1").get(envId) as
      | { seq: number; id: string; env: string; hook: string; headers: string; body: Uint8Array; received_at: number }
      | undefined;
    if (row === undefined) return undefined;
    return { seq: row.seq, id: row.id, envId: row.env, hookId: row.hook, headers: JSON.parse(row.headers) as Headers, body: Buffer.from(row.body), receivedAt: row.received_at };
  }

  pending(envId: string): number {
    this.prune();
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM hooks WHERE env = ?").get(envId) as { n: number }).n;
  }

  remove(seq: number): void {
    this.#db.prepare("DELETE FROM hooks WHERE seq = ?").run(seq);
  }

  /** Drops everything older than 24 h. */
  prune(): void {
    const cutoff = this.#now() - HOOK_TTL_MS;
    this.#db.prepare("DELETE FROM hooks WHERE received_at <= ?").run(cutoff);
    this.#db.prepare("DELETE FROM deliveries WHERE at <= ?").run(cutoff);
  }

  close(): void {
    this.#db.close();
  }
}
