import { join } from "node:path";
import type { FileRecord } from "../index.ts";
import { num, str, type ScanOptions, type UsageRecord } from "../types.ts";
import { LATE_SLACK_MS, listLogFiles, parseJson, parseTime, type LogFile } from "./files.ts";
import { isEmpty, scanLogFiles, type FileParser } from "./logscan.ts";

/**
 * Extracts `<conversation-id>` from `<root>/<conversation-id>/.system_generated/logs/transcript.jsonl`.
 */
export function conversationIdFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const parts = filePath.split(/[\\/]+/);
  const idx = parts.lastIndexOf(".system_generated");
  if (idx > 0 && parts[idx - 1]) return parts[idx - 1];
  return undefined;
}

/**
 * Antigravity CLI / App: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
 * (and `~/.gemini/antigravity/brain/...` if present). Each `PLANNER_RESPONSE` step records
 * uncached `input_tokens`, `cache_read_tokens`, `output_tokens`, `model`, `step_index`, and
 * `created_at`. Antigravity writes no cost figure; Tide estimates spend from its price table.
 */
export const parseAntigravityFile: FileParser = async (lines, until, filePath) => {
  const records: FileRecord[] = [];
  const inFile = new Set<string>();
  const sessionId = conversationIdFromPath(filePath);
  for await (const line of lines) {
    if (!line.includes('"PLANNER_RESPONSE"') || !line.includes('"input_tokens"')) continue;
    const o = parseJson(line);
    if (!o || o.type !== "PLANNER_RESPONSE") continue;
    const at = parseTime(o.created_at);
    if (at === undefined) continue;
    if (at > until + LATE_SLACK_MS) return { records, partial: true };
    const step = typeof o.step_index === "number" && Number.isFinite(o.step_index) ? String(o.step_index) : str(o.step_index);
    const key = sessionId !== undefined && step !== undefined ? `${sessionId}:${step}` : undefined;
    if (key !== undefined) {
      if (inFile.has(key)) continue;
      inFile.add(key);
    }
    const model = str(o.model);
    const r: FileRecord = {
      at,
      tokens: {
        in: num(o.input_tokens),
        out: num(o.output_tokens),
        cacheRead: num(o.cache_read_tokens),
        cacheWrite: num(o.cache_write_tokens),
      },
      ...(key !== undefined ? { key } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    if (!isEmpty(r)) records.push(r);
  }
  return { records, partial: false };
};

export async function* scanAntigravity(options: ScanOptions): AsyncGenerator<UsageRecord> {
  const roots = [
    join(options.home, ".gemini", "antigravity-cli", "brain"),
    join(options.home, ".gemini", "antigravity", "brain"),
  ];
  const accept = (name: string): boolean => name === "transcript.jsonl";
  const byPath = new Map<string, LogFile>();
  for (const root of roots) {
    for (const file of await listLogFiles(root, options.since, options.stats, accept)) {
      if (!byPath.has(file.path)) byPath.set(file.path, file);
    }
  }
  yield* scanLogFiles("antigravity", [...byPath.values()], parseAntigravityFile, options, options.index);
}
