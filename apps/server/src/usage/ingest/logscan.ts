import type { ProviderKind } from "@tide/contracts";
import type { FileRecord, UsageIndex } from "../index.ts";
import type { ScanOptions, UsageRecord } from "../types.ts";
import { readLines, type LogFile } from "./files.ts";

/** Parses one log file; `partial` = it stopped early (records past `until`), so it is not cached. */
export type FileParser = (lines: AsyncIterable<string>, until: number) => Promise<{ records: FileRecord[]; partial: boolean }>;

/**
 * The shared half of every jsonl ingester: index lookup or parse, window filter, cross-file
 * dedupe by key (first sighting wins, in file order), Tide exclusion, stats.
 */
export async function* scanLogFiles(
  provider: ProviderKind,
  files: LogFile[],
  parse: FileParser,
  options: ScanOptions,
  index?: UsageIndex,
): AsyncGenerator<UsageRecord> {
  const { since, until, stats, exclude } = options;
  const seen = new Set<string>();
  // stable order: dedupe must pick the same "first" file whether the records came from the index or a read
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of files) {
    let records = index?.get(file.path, file.mtimeMs, file.size);
    if (records !== undefined) {
      if (stats) stats.filesFromIndex++;
    } else {
      if (stats) stats.filesScanned++;
      const parsed = await parse(readLines(file.path), until);
      records = parsed.records;
      if (!parsed.partial) index?.put(file.path, file.mtimeMs, file.size, records);
    }
    for (const r of records) {
      if (r.key !== undefined) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
      }
      if (r.at < since || r.at > until) continue;
      const record: UsageRecord = {
        provider,
        at: r.at,
        tokens: r.tokens,
        ...(r.model !== undefined ? { model: r.model } : {}),
        ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
        ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
        ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      };
      if (exclude?.(record)) {
        if (stats) stats.excluded++;
        continue;
      }
      if (stats) stats.records++;
      yield record;
    }
  }
}

export function isEmpty(r: FileRecord): boolean {
  return r.tokens.in + r.tokens.out + r.tokens.cacheRead + r.tokens.cacheWrite === 0;
}
