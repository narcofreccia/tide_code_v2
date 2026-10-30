import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collect, OCT_19, OCT_21, sum } from "../testing/fixtures.ts";
import { emptyStats } from "../types.ts";
import { excluder } from "./dedupe.ts";
import { opencodeModel, scanOpencode } from "./opencode.ts";

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const AT = Date.parse("2026-10-20T12:00:00Z");

/** session_v2 with the real column set OpenCode ships (the ones the ingester reads, plus the NOT NULL neighbours) */
async function homeWithDb(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "tide-opencode-"));
  const dir = join(tmp, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, version text NOT NULL,
    cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
    tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, model text, time_created integer NOT NULL, time_updated integer NOT NULL)`);
  const ins = db.prepare("insert into session_v2 values (?, 'p', 's', ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  ins.run("ses_free", "/Users/me/proj", 0, 1000, 200, 50, 300, 0, '{"id":"big-pickle","providerID":"opencode"}', AT, AT);
  ins.run("ses_paid", "/Users/me/proj", 0.42, 2000, 100, 0, 0, 10, '{"id":"claude-sonnet-5-5","providerID":"anthropic"}', AT, AT + 1000);
  ins.run("ses_tide", "/tide-home/worktrees/p/t", 1, 9, 9, 0, 0, 0, null, AT, AT);
  ins.run("ses_old", "/Users/me/proj", 3, 9, 9, 0, 0, 0, null, 0, 1000);
  db.close();
  return tmp;
}

describe("opencode ingester", () => {
  it("reads session totals from the sqlite store read-only, cost included, reasoning folded into output", async () => {
    const home = await homeWithDb();
    const stats = emptyStats();
    const records = await collect(scanOpencode({ home, since: OCT_19, until: OCT_21, stats, exclude: excluder({ sessionIds: new Set(), cwdPrefixes: ["/tide-home/worktrees"] }) }));
    expect(records.map((r) => r.sessionId).sort()).toEqual(["ses_free", "ses_paid"]);
    expect(sum(records)).toEqual({ in: 3000, out: 350, cacheRead: 300, cacheWrite: 10 });
    expect(records.find((r) => r.sessionId === "ses_paid")).toMatchObject({ model: "anthropic/claude-sonnet-5-5", costUsd: 0.42 });
    expect(records.find((r) => r.sessionId === "ses_free")).toMatchObject({ model: "opencode/big-pickle", costUsd: 0 });
    expect(stats.excluded).toBe(1);
  });

  it("falls back to the legacy per-message JSON when there is no db", async () => {
    tmp = await mkdtemp(join(tmpdir(), "tide-opencode-"));
    const dir = join(tmp, ".local", "share", "opencode", "storage", "message", "ses_x");
    mkdirSync(dir, { recursive: true });
    const base = { sessionID: "ses_x", time: { created: AT }, path: { cwd: "/Users/me/proj", root: "/" } };
    writeFileSync(join(dir, "msg_1.json"), JSON.stringify({ ...base, id: "msg_1", role: "user" }));
    writeFileSync(join(dir, "msg_2.json"), JSON.stringify({ ...base, id: "msg_2", role: "assistant", modelID: "big-pickle", providerID: "opencode", cost: 0, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } } }));
    const records = await collect(scanOpencode({ home: tmp, since: OCT_19, until: OCT_21 }));
    expect(records).toEqual([{ provider: "opencode", at: AT, tokens: { in: 10, out: 6, cacheRead: 2, cacheWrite: 0 }, costUsd: 0, model: "opencode/big-pickle", sessionId: "ses_x", cwd: "/Users/me/proj" }]);
  });

  it("names models from OpenCode's JSON model column", () => {
    expect(opencodeModel('{"id":"gpt-6-luna","providerID":"openai"}')).toBe("openai/gpt-6-luna");
    expect(opencodeModel("plain-model")).toBe("plain-model");
    expect(opencodeModel(null)).toBeUndefined();
  });
});
