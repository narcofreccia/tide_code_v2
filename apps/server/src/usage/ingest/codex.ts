import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileRecord } from "../index.ts";
import { DAY_MS, num, str, type ScanOptions, type UsageRecord, type UsageTokens } from "../types.ts";
import { LATE_SLACK_MS, listLogFiles, MAX_FILE_BYTES, obj, parseJson, parseTime, type LogFile } from "./files.ts";
import { isEmpty, scanLogFiles, type FileParser } from "./logscan.ts";
import { hasTable, openReadOnly } from "./sqlite.ts";

/** OpenAI totals count cached input inside `input_tokens`; split it so `in` is uncached like every other harness. */
function tokensOf(u: Record<string, unknown>): UsageTokens {
  const cached = num(u.cached_input_tokens);
  return { in: Math.max(0, num(u.input_tokens) - cached), out: num(u.output_tokens), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens) };
}

function minus(a: UsageTokens, b: UsageTokens): UsageTokens {
  return { in: Math.max(0, a.in - b.in), out: Math.max(0, a.out - b.out), cacheRead: Math.max(0, a.cacheRead - b.cacheRead), cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite) };
}

/**
 * Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`): `session_meta` (id, cwd),
 * `turn_context` (model), and per response either a `token_usage_record` (current CLIs, keyed
 * by response id) or only `event_msg/token_count` with running totals (older CLIs: the deltas
 * between successive totals are the calls). Codex writes no cost.
 */
export const parseCodexFile: FileParser = async (lines, until) => {
  const fromRecords: FileRecord[] = [];
  const fromCounts: FileRecord[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let lastTotal: UsageTokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const ctx = (): Pick<FileRecord, "model" | "sessionId" | "cwd"> => ({
    ...(model !== undefined ? { model } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  });
  let partial = false;
  for await (const line of lines) {
    const o = parseJson(line);
    if (!o) continue;
    const payload = obj(o.payload) ?? {};
    const at = parseTime(o.timestamp);
    if (o.type === "session_meta") {
      sessionId = str(payload.id) ?? str(payload.session_id) ?? sessionId;
      cwd = str(payload.cwd) ?? cwd;
      continue;
    }
    if (o.type === "turn_context") {
      model = str(payload.model) ?? model;
      cwd = str(payload.cwd) ?? cwd;
      continue;
    }
    if (at === undefined) continue;
    if (o.type === "token_usage_record") {
      if (at > until + LATE_SLACK_MS) {
        partial = true;
        break;
      }
      const u = obj(payload.usage) ?? obj(payload.turn_token_usage);
      if (!u) continue;
      const key = str(payload.response_id);
      const r: FileRecord = { at, tokens: tokensOf(u), ...ctx(), ...(key !== undefined ? { key: `codex:${key}` } : {}) };
      if (!isEmpty(r)) fromRecords.push(r);
    } else if (o.type === "event_msg" && payload.type === "token_count") {
      if (at > until + LATE_SLACK_MS) {
        partial = true;
        break;
      }
      const total = obj(obj(payload.info)?.total_token_usage);
      if (!total) continue;
      const t = tokensOf(total);
      const r: FileRecord = { at, tokens: minus(t, lastTotal), ...ctx() };
      lastTotal = t;
      if (!isEmpty(r)) fromCounts.push(r);
    }
  }
  return { records: fromRecords.length > 0 ? fromRecords : fromCounts, partial };
};

/**
 * Rollouts to read: the state db (`~/.codex/state_5.sqlite`, `threads.rollout_path`) names the
 * threads touched in the window without walking the date tree; without it, the tree is walked.
 * A thread whose rollout is gone is counted from `tokens_used` (no input/output split).
 */
async function codexFiles(options: ScanOptions): Promise<{ files: LogFile[]; orphans: FileRecord[] }> {
  const root = join(options.home, ".codex");
  const db = await openReadOnly(join(root, "state_5.sqlite"), options.tmpDir);
  if (!db) return { files: await listLogFiles(join(root, "sessions"), options.since, options.stats), orphans: [] };
  try {
    if (!hasTable(db, "threads")) return { files: await listLogFiles(join(root, "sessions"), options.since, options.stats), orphans: [] };
    const floorSec = Math.floor((options.since - DAY_MS) / 1000);
    const rows = db.all("select id, rollout_path, updated_at, cwd, model, tokens_used from threads where updated_at >= ?", floorSec);
    const files: LogFile[] = [];
    const orphans: FileRecord[] = [];
    for (const row of rows) {
      const path = str(row.rollout_path);
      try {
        if (path === undefined) throw new Error("no rollout");
        const s = await stat(path);
        if (s.size > MAX_FILE_BYTES) {
          options.stats?.skipped.push(path);
          continue;
        }
        files.push({ path, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        const used = num(row.tokens_used);
        const id = str(row.id);
        const cwd = str(row.cwd);
        const model = str(row.model);
        if (used > 0) orphans.push({ at: num(row.updated_at) * 1000, tokens: { in: used, out: 0, cacheRead: 0, cacheWrite: 0 }, ...(id !== undefined ? { sessionId: id } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(model !== undefined ? { model } : {}) });
      }
    }
    return { files, orphans };
  } finally {
    await db.close();
  }
}

export async function* scanCodex(options: ScanOptions): AsyncGenerator<UsageRecord> {
  const { files, orphans } = await codexFiles(options);
  yield* scanLogFiles("codex", files, parseCodexFile, options, options.index);
  let counted = 0;
  for (const r of orphans) {
    if (r.at < options.since || r.at > options.until) continue;
    const record: UsageRecord = { provider: "codex", at: r.at, tokens: r.tokens, ...(r.model !== undefined ? { model: r.model } : {}), ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}), ...(r.cwd !== undefined ? { cwd: r.cwd } : {}) };
    if (options.exclude?.(record)) {
      if (options.stats) options.stats.excluded++;
      continue;
    }
    counted++;
    if (options.stats) options.stats.records++;
    yield record;
  }
  if (counted > 0) options.stats?.notes.push(`${counted} Codex thread(s) had no rollout file; counted from the thread total as input (no input/output split).`);
}
