import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasTable, openReadOnly } from "./sqlite.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("harness sqlite reader", () => {
  it("reads a live WAL database through a scratch copy, leaving the harness's files untouched", async () => {
    dir = await mkdtemp(join(tmpdir(), "tide-sqlite-"));
    const scratch = await mkdtemp(join(dir, "scratch-"));
    const path = join(dir, "harness.db");
    // the harness keeps its connection open: the row lives only in the -wal
    const live = new DatabaseSync(path);
    live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (42);");
    const before = await Promise.all(["", "-wal", "-shm"].map(async (s) => (await stat(path + s)).mtimeMs));
    const db = await openReadOnly(path, scratch);
    expect(db).toBeDefined();
    expect(hasTable(db!, "t")).toBe(true);
    expect(db!.all("select v from t")).toEqual([{ v: 42 }]);
    await db!.close();
    const after = await Promise.all(["", "-wal", "-shm"].map(async (s) => (await stat(path + s)).mtimeMs));
    expect(after).toEqual(before);
    expect(await readdir(scratch)).toEqual([]);
    live.close();
  });

  it("returns undefined for a missing file", async () => {
    expect(await openReadOnly("/nonexistent/harness.db")).toBeUndefined();
  });
});
