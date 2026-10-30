import { describe, expect, it } from "vitest";
import { UsageIndex } from "../index.ts";
import { collect, FIXTURE_HOME, OCT_19, OCT_21, OCT_31, sum } from "../testing/fixtures.ts";
import { emptyStats } from "../types.ts";
import { parseClaudeFile, scanClaude } from "./claude.ts";
import { excluder } from "./dedupe.ts";
import { readLines } from "./files.ts";
import { join } from "node:path";

const SESS_A = join(FIXTURE_HOME, ".claude/projects/-Users-me-proj/sess-a.jsonl");

describe("claude ingester", () => {
  it("dedupes streamed lines and copies across files by message id + request id", async () => {
    const stats = emptyStats();
    const records = await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21, stats }));
    expect(records).toHaveLength(5);
    expect(sum(records)).toEqual({ in: 50, out: 500, cacheRead: 11000, cacheWrite: 1000 });
    expect(stats.filesScanned).toBe(3);
    expect(records.every((r) => r.provider === "claude" && r.costUsd === undefined)).toBe(true);
  });

  it("keeps model, session and cwd and drops zero-usage synthetic messages", async () => {
    const records = await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21 }));
    expect(records.map((r) => r.model).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(records.find((r) => r.model === "claude-sonnet-5-5")).toMatchObject({ sessionId: "sess-a", cwd: "/Users/me/proj" });
  });

  it("honours the window", async () => {
    expect(await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_31 }))).toHaveLength(6);
    expect(await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_21, until: OCT_31 }))).toHaveLength(1);
  });

  it("excludes Tide's sessions and worktree cwds, counting them", async () => {
    const stats = emptyStats();
    const exclude = excluder({ sessionIds: new Set(["sess-tide"]), cwdPrefixes: ["/tide-home/worktrees"] });
    const records = await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21, stats, exclude }));
    expect(records).toHaveLength(3);
    expect(stats.excluded).toBe(2);
  });

  it("stops reading a file once timestamps pass the window, and does not cache that partial read", async () => {
    const until = Date.parse("2026-10-20T07:00:00.000Z");
    const parsed = await parseClaudeFile(readLines(SESS_A), until);
    expect(parsed).toEqual({ records: [], partial: true });
    const index = new UsageIndex();
    await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until, index }));
    // every fixture file has a call past until + 1 h, so nothing was cached
    expect(index.size).toBe(0);
  });

  it("a warm scan reuses the index and gives the same totals", async () => {
    const index = new UsageIndex();
    const cold = emptyStats();
    const first = await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_31, stats: cold, index }));
    const warm = emptyStats();
    const second = await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_31, stats: warm, index }));
    expect(warm.filesScanned).toBe(0);
    expect(warm.filesFromIndex).toBe(3);
    expect(sum(second)).toEqual(sum(first));
    // one index serves a narrower window too
    expect(await collect(scanClaude({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21, index }))).toHaveLength(5);
  });

  it("yields nothing when the harness was never installed", async () => {
    expect(await collect(scanClaude({ home: "/nonexistent-home", since: OCT_19, until: OCT_21 }))).toEqual([]);
  });
});
