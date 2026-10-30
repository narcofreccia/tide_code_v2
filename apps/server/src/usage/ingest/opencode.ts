import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { num, str, type ScanOptions, type UsageRecord } from "../types.ts";
import { listLogFiles, obj, parseJson, parseTime } from "./files.ts";
import { hasTable, openReadOnly } from "./sqlite.ts";

/** `{"id":"big-pickle","providerID":"opencode"}` → `opencode/big-pickle`; plain strings pass through */
export function opencodeModel(raw: unknown): string | undefined {
  const s = str(raw);
  if (s === undefined) return undefined;
  const o = s.startsWith("{") ? parseJson(s) : undefined;
  if (!o) return s;
  const id = str(o.id) ?? str(o.modelID);
  const provider = str(o.providerID);
  return id === undefined ? undefined : provider !== undefined ? `${provider}/${id}` : id;
}

function emit(options: ScanOptions, record: UsageRecord): boolean {
  if (record.at < options.since || record.at > options.until) return false;
  if (record.tokens.in + record.tokens.out + record.tokens.cacheRead + record.tokens.cacheWrite === 0 && !record.costUsd) return false;
  if (options.exclude?.(record)) {
    if (options.stats) options.stats.excluded++;
    return false;
  }
  if (options.stats) options.stats.records++;
  return true;
}

/**
 * OpenCode keeps per-session totals in `~/.local/share/opencode/opencode.db` (`session_v2`),
 * cost included. A session counts at its last update, so one long session lands on one day.
 * Reasoning tokens are billed as output and folded into `out`. Before the SQLite store,
 * OpenCode wrote one JSON file per message under `storage/message/`; read only when no db.
 */
export async function* scanOpencode(options: ScanOptions): AsyncGenerator<UsageRecord> {
  const root = join(options.home, ".local", "share", "opencode");
  const db = await openReadOnly(join(root, "opencode.db"), options.tmpDir);
  if (db) {
    try {
      if (hasTable(db, "session_v2")) {
        if (options.stats) options.stats.filesScanned++;
        const rows = db.all(
          "select id, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated from session_v2 where time_updated >= ? and time_updated <= ?",
          options.since,
          options.until,
        );
        for (const row of rows) {
          const model = opencodeModel(row.model);
          const sessionId = str(row.id);
          const cwd = str(row.directory);
          const record: UsageRecord = {
            provider: "opencode",
            at: num(row.time_updated),
            tokens: { in: num(row.tokens_input), out: num(row.tokens_output) + num(row.tokens_reasoning), cacheRead: num(row.tokens_cache_read), cacheWrite: num(row.tokens_cache_write) },
            costUsd: num(row.cost),
            ...(model !== undefined ? { model } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
          };
          if (emit(options, record)) yield record;
        }
        return;
      }
    } finally {
      await db.close();
    }
  }
  const files = await listLogFiles(join(root, "storage", "message"), options.since, options.stats, (n) => n.endsWith(".json"));
  for (const file of files) {
    if (options.stats) options.stats.filesScanned++;
    let o: Record<string, unknown> | undefined;
    try {
      o = parseJson(await readFile(file.path, "utf8"));
    } catch {
      continue;
    }
    if (!o || o.role !== "assistant") continue;
    const at = parseTime(obj(o.time)?.created);
    const tokens = obj(o.tokens);
    if (at === undefined || !tokens) continue;
    const cache = obj(tokens.cache) ?? {};
    const id = str(o.modelID);
    const provider = str(o.providerID);
    const model = id === undefined ? undefined : provider !== undefined ? `${provider}/${id}` : id;
    const sessionId = str(o.sessionID);
    const cwd = str(obj(o.path)?.cwd);
    const record: UsageRecord = {
      provider: "opencode",
      at,
      tokens: { in: num(tokens.input), out: num(tokens.output) + num(tokens.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) },
      ...(typeof o.cost === "number" ? { costUsd: o.cost } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    if (emit(options, record)) yield record;
  }
}
