import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DAY_MS, type ScanStats } from "../types.ts";

/** A harness log larger than this is skipped with a note rather than streamed on every page load. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface LogFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every `*.jsonl` under `root` (recursively) that could hold a record at or after `since`:
 * a file last written more than a day before the window cannot. Files over the size cap are
 * listed in `stats.skipped` and left out. A missing root yields nothing.
 */
export async function listLogFiles(root: string, since: number, stats?: ScanStats, accept: (name: string) => boolean = (n) => n.endsWith(".jsonl")): Promise<LogFile[]> {
  const out: LogFile[] = [];
  const floor = since - DAY_MS;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.isFile() || !accept(e.name)) continue;
      let s;
      try {
        s = await stat(p);
      } catch {
        continue;
      }
      if (s.mtimeMs < floor) continue;
      if (s.size > MAX_FILE_BYTES) {
        stats?.skipped.push(p);
        continue;
      }
      out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
    }
  };
  await walk(root);
  return out;
}

/** Streams a file line by line; never holds the whole file. Unreadable files end quietly. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.length > 0) yield line;
  } catch {
    // vanished or unreadable mid-scan: whatever was read stands
  } finally {
    lines.close();
    input.destroy();
  }
}

export function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function parseTime(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * Logs are append-only and roughly chronological, but not strictly (subagent results land late).
 * Reading stops once a timestamp is this far past `until`.
 */
export const LATE_SLACK_MS = 60 * 60 * 1000;
