import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collect, FIXTURE_HOME, OCT_19, OCT_21, sum } from "../testing/fixtures.ts";
import { emptyStats } from "../types.ts";
import { scanCodex } from "./codex.ts";
import { excluder } from "./dedupe.ts";

const ROLLOUTS = join(FIXTURE_HOME, ".codex/sessions/2026/10/20");
const NEW = join(ROLLOUTS, "rollout-2026-10-20T08-00-00-cdx-new.jsonl");
const OLD = join(ROLLOUTS, "rollout-2026-10-20T09-00-00-cdx-old.jsonl");

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** a home whose state db lists the fixture rollouts plus one thread whose rollout is gone */
async function homeWithStateDb(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "tide-codex-"));
  mkdirSync(join(tmp, ".codex"));
  const db = new DatabaseSync(join(tmp, ".codex", "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL,
    model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  const ins = db.prepare("insert into threads values (?, ?, ?, ?, 'cli', 'openai', ?, 't', 'x', 'x', ?, ?)");
  const sec = Math.floor(Date.parse("2026-10-20T10:00:00Z") / 1000);
  ins.run("cdx-new", NEW, sec, sec, "/Users/me/proj", 31100, "gpt-6-luna");
  ins.run("cdx-gone", join(tmp, "missing.jsonl"), sec, sec, "/Users/me/gone", 500, "gpt-6.1");
  ins.run("cdx-ancient", OLD, 1_000, 1_000, "/Users/me/other", 9, "gpt-6.1-sol");
  db.close();
  return tmp;
}

describe("codex ingester", () => {
  it("reads token_usage_record per response and splits cached input out of input", async () => {
    const records = await collect(scanCodex({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21 }));
    const fresh = records.filter((r) => r.sessionId === "cdx-new");
    expect(fresh).toHaveLength(2);
    expect(sum(fresh)).toEqual({ in: 5000, out: 100, cacheRead: 26000, cacheWrite: 0 });
    expect(fresh[0]).toMatchObject({ provider: "codex", model: "gpt-6-luna", cwd: "/Users/me/proj" });
    expect(records.every((r) => r.costUsd === undefined)).toBe(true);
  });

  it("falls back to deltas of token_count totals on older rollouts, skipping repeats", async () => {
    const records = await collect(scanCodex({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21 }));
    const old = records.filter((r) => r.sessionId === "cdx-old");
    expect(old).toHaveLength(2);
    expect(sum(old)).toEqual({ in: 1100, out: 30, cacheRead: 1400, cacheWrite: 0 });
    expect(old[0]?.model).toBe("gpt-6.1-sol");
  });

  it("walks the date tree when there is no state db", async () => {
    const stats = emptyStats();
    await collect(scanCodex({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21, stats }));
    expect(stats.filesScanned).toBe(2);
  });

  it("uses the state db's threads to pick rollouts and counts a thread whose rollout is gone", async () => {
    const home = await homeWithStateDb();
    const stats = emptyStats();
    const records = await collect(scanCodex({ home, since: OCT_19, until: OCT_21, stats }));
    // cdx-ancient is outside the window by updated_at: its rollout is not even opened
    expect(stats.filesScanned).toBe(1);
    expect(records.filter((r) => r.sessionId === "cdx-new")).toHaveLength(2);
    expect(records.find((r) => r.sessionId === "cdx-gone")).toMatchObject({ model: "gpt-6.1", tokens: { in: 500, out: 0 } });
    expect(stats.notes.join(" ")).toMatch(/no rollout file/);
  });

  it("excludes Tide's codex threads by native session id", async () => {
    const stats = emptyStats();
    const records = await collect(scanCodex({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21, stats, exclude: excluder({ sessionIds: new Set(["cdx-new"]), cwdPrefixes: [] }) }));
    expect(records.every((r) => r.sessionId === "cdx-old")).toBe(true);
    expect(stats.excluded).toBe(2);
  });
});
