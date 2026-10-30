import { join } from "node:path";
import type { FileRecord } from "../index.ts";
import { num, str, type ScanOptions, type UsageRecord } from "../types.ts";
import { LATE_SLACK_MS, listLogFiles, obj, parseJson, parseTime } from "./files.ts";
import { isEmpty, scanLogFiles, type FileParser } from "./logscan.ts";

/**
 * Pi: `~/.pi/agent/sessions/<slug>/*.jsonl`. The `session` header carries id and cwd; each
 * assistant `message` carries `usage{input, output, cacheRead, cacheWrite, cost{total}}` and
 * `model` / `provider`. Pi prices its own calls, so cost is reported.
 */
export const parsePiFile: FileParser = async (lines, until) => {
  const records: FileRecord[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  for await (const line of lines) {
    const o = parseJson(line);
    if (!o) continue;
    if (o.type === "session") {
      sessionId = str(o.id) ?? sessionId;
      cwd = str(o.cwd) ?? cwd;
      continue;
    }
    if (o.type !== "message") continue;
    const message = obj(o.message);
    const usage = obj(message?.usage);
    if (!message || !usage || message.role !== "assistant") continue;
    const at = parseTime(o.timestamp) ?? parseTime(message.timestamp);
    if (at === undefined) continue;
    if (at > until + LATE_SLACK_MS) return { records, partial: true };
    const cost = obj(usage.cost)?.total;
    const model = str(message.model);
    const r: FileRecord = {
      at,
      tokens: { in: num(usage.input), out: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite) },
      ...(typeof cost === "number" ? { costUsd: cost } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    if (!isEmpty(r)) records.push(r);
  }
  return { records, partial: false };
};

export async function* scanPi(options: ScanOptions): AsyncGenerator<UsageRecord> {
  const files = await listLogFiles(join(options.home, ".pi", "agent", "sessions"), options.since, options.stats);
  yield* scanLogFiles("pi", files, parsePiFile, options, options.index);
}
