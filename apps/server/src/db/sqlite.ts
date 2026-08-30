// Runtime-neutral SQLite adapter: bun:sqlite under Bun, node:sqlite otherwise.
// Both drivers expose the same shape for what we use (exec / prepare / run-get-all),
// so we only need a thin normalising wrapper.

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlParam[]): void;
  get(...params: SqlParam[]): Record<string, unknown> | undefined;
  all(...params: SqlParam[]): Record<string, unknown>[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs fn inside a single transaction; rolls back if it throws. Not reentrant. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- driver import boundary */
interface RawStatement {
  run(...p: any[]): unknown;
  get(...p: any[]): any;
  all(...p: any[]): any;
}
interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): RawStatement;
  close(): void;
}

const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function openRaw(path: string): Promise<RawDatabase> {
  if (isBun()) {
    // @ts-ignore bun:sqlite only resolves under the Bun runtime
    const mod: any = await import("bun:sqlite");
    return new mod.Database(path) as RawDatabase;
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path) as unknown as RawDatabase;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function openDatabase(path: string): Promise<Database> {
  const raw = await openRaw(path);
  const isMemory = path === ":memory:" || path === "";
  if (!isMemory) {
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec("PRAGMA synchronous = NORMAL;");
  }
  raw.exec("PRAGMA foreign_keys = ON;");

  let depth = 0;
  return {
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        run(...params) {
          st.run(...params);
        },
        get(...params) {
          return (st.get(...params) ?? undefined) as Record<string, unknown> | undefined;
        },
        all(...params) {
          return (st.all(...params) ?? []) as Record<string, unknown>[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn(); // already inside a transaction: join it
      depth++;
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* rollback of an already-aborted tx is fine */
        }
        throw err;
      } finally {
        depth--;
      }
    },
    close() {
      raw.close();
    },
  };
}
