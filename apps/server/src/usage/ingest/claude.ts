import { join } from "node:path";
import type { FileRecord } from "../index.ts";
import { num, str, type ScanOptions, type UsageRecord } from "../types.ts";
import { LATE_SLACK_MS, listLogFiles, obj, parseJson, parseTime } from "./files.ts";
import { isEmpty, scanLogFiles, type FileParser } from "./logscan.ts";

/**
 * Claude Code: `~/.claude/projects/<slug>/**\/*.jsonl` (subagents included). Each `assistant`
 * line carries `message.usage`; a streamed message is written once per content block with the
 * same usage, and resumed/forked sessions copy history into new files, so records are keyed by
 * `message.id` + `requestId` across the whole scan. Claude Code writes no cost.
 */
export const parseClaudeFile: FileParser = async (lines, until) => {
  const records: FileRecord[] = [];
  const inFile = new Set<string>();
  for await (const line of lines) {
    // cheap prefilter: most lines are user turns, tool results and attachments
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    const o = parseJson(line);
    if (!o || o.type !== "assistant") continue;
    const at = parseTime(o.timestamp);
    if (at === undefined) continue;
    if (at > until + LATE_SLACK_MS) return { records, partial: true };
    const message = obj(o.message);
    const usage = obj(message?.usage);
    if (!message || !usage) continue;
    const id = str(message.id);
    const key = id !== undefined ? `${id}:${str(o.requestId) ?? ""}` : undefined;
    if (key !== undefined) {
      if (inFile.has(key)) continue;
      inFile.add(key);
    }
    const model = str(message.model);
    const sessionId = str(o.sessionId);
    const cwd = str(o.cwd);
    const r: FileRecord = {
      at,
      tokens: {
        in: num(usage.input_tokens),
        out: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
      },
      ...(key !== undefined ? { key } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    if (!isEmpty(r)) records.push(r);
  }
  return { records, partial: false };
};

export async function* scanClaude(options: ScanOptions): AsyncGenerator<UsageRecord> {
  const files = await listLogFiles(join(options.home, ".claude", "projects"), options.since, options.stats);
  yield* scanLogFiles("claude", files, parseClaudeFile, options, options.index);
}
