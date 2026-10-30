import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageIndex, type FileRecord } from "./index.ts";

const recs: FileRecord[] = [
  { key: "a:1", at: Date.now(), model: "claude-opus-5-5", sessionId: "s", cwd: "/p", tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 } },
  { at: Date.now(), sessionId: "other", cwd: "/p", tokens: { in: 5, out: 6, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 },
];

describe("usage index", () => {
  it("hits only on unchanged mtime and size", () => {
    const index = new UsageIndex();
    index.put("/f", 10, 100, recs);
    expect(index.get("/f", 10, 100)).toBe(recs);
    expect(index.get("/f", 11, 100)).toBeUndefined();
    expect(index.get("/f", 10, 101)).toBeUndefined();
  });

  it("round-trips through its compact file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tide-usage-index-"));
    try {
      const path = UsageIndex.pathFor(dir);
      expect(path).toBe(join(dir, "usage-index.json"));
      const now = Date.now();
      const a = new UsageIndex(path);
      a.put("/f", now, 100, recs);
      a.put("/stale", now - 400 * 86_400_000, 1, recs);
      await a.save(now);
      expect(JSON.parse(await readFile(join(dir, "usage-index.json"), "utf8")).version).toBe(2);
      const b = new UsageIndex(path);
      await b.load();
      expect(b.get("/f", now, 100)).toEqual(recs);
      expect(b.get("/stale", now - 400 * 86_400_000, 1)).toBeUndefined();
      expect(UsageIndex.pathFor(":memory:")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
