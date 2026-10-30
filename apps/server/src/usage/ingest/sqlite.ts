import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any -- driver import boundary */
export interface ReadOnlyDb {
  all(sql: string, ...params: (string | number)[]): Record<string, unknown>[];
  /** closes and deletes the scratch copy */
  close(): Promise<void>;
}

async function openRaw(path: string): Promise<any> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    // @ts-ignore bun:sqlite only resolves under the Bun runtime
    const mod: any = await import("bun:sqlite");
    return new mod.Database(path);
  }
  const { DatabaseSync } = await import("node:sqlite");
  // the copy is ours: opened read-write so SQLite can fold the copied -wal in
  return new DatabaseSync(path);
}

function wrap(raw: any, cleanup?: () => Promise<void>): ReadOnlyDb {
  return {
    all: (sql, ...params) => (raw.prepare(sql).all(...params) ?? []) as Record<string, unknown>[],
    close: async () => {
      raw.close();
      await cleanup?.();
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Opens a harness's SQLite file without touching it. Even a read-only open of a WAL database
 * writes the harness's `-shm` (reader locks), so the db and its `-wal` are copied to a scratch
 * dir and read there; the copy is deleted on close. These stores are small (MBs), and the
 * external scan runs at most every five minutes per window. Returns undefined when absent.
 */
export async function openReadOnly(path: string, tmpRoot?: string): Promise<ReadOnlyDb | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  const dir = await mkdtemp(join(tmpRoot ?? tmpdir(), "tide-usage-"));
  const copy = join(dir, basename(path));
  try {
    await copyFile(path, copy);
    await copyFile(`${path}-wal`, `${copy}-wal`).catch(() => undefined);
    return wrap(await openRaw(copy), () => rm(dir, { recursive: true, force: true }));
  } catch {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  }
}

export function hasTable(db: ReadOnlyDb, table: string): boolean {
  return db.all("select name from sqlite_master where type = 'table' and name = ?", table).length > 0;
}
