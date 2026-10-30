import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DAY_MS, type UsageTokens } from "./types.ts";

/** One parsed record as a file holds it, before window, dedupe and exclusion. */
export interface FileRecord {
  /** dedupe key across files (Claude message.id+requestId, Codex response id) */
  key?: string;
  at: number;
  model?: string;
  sessionId?: string;
  cwd?: string;
  tokens: UsageTokens;
  costUsd?: number;
}

interface Entry {
  mtimeMs: number;
  size: number;
  records: FileRecord[];
}

const VERSION = 2;

/** on disk: tokens as a tuple, the file's common session/cwd/model hoisted, so the index stays a few MB */
type Row = [key: string | null, at: number, model: number, i: number, o: number, cr: number, cw: number, cost: number | null, session: string | null, cwd: string | null];
interface DiskEntry {
  m: number;
  z: number;
  /** models used in the file; rows point into it */
  models: string[];
  s: string | null;
  c: string | null;
  r: Row[];
}

function mostCommon(values: (string | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function toDisk(e: Entry): DiskEntry {
  const s = mostCommon(e.records.map((r) => r.sessionId));
  const c = mostCommon(e.records.map((r) => r.cwd));
  const models: string[] = [];
  const rows = e.records.map((r): Row => {
    let mi = -1;
    if (r.model !== undefined) {
      mi = models.indexOf(r.model);
      if (mi < 0) mi = models.push(r.model) - 1;
    }
    return [
      r.key ?? null, r.at, mi, r.tokens.in, r.tokens.out, r.tokens.cacheRead, r.tokens.cacheWrite, r.costUsd ?? null,
      r.sessionId === undefined ? null : r.sessionId === s ? null : r.sessionId,
      r.cwd === undefined ? null : r.cwd === c ? null : r.cwd,
    ];
  });
  // a record without a session/cwd while the file has one is rare enough to fold into the default
  return { m: e.mtimeMs, z: e.size, models, s, c, r: rows };
}

function fromDisk(d: DiskEntry): Entry {
  const records = d.r.map(([key, at, mi, i, o, cr, cw, cost, session, cwd]): FileRecord => {
    const model = mi >= 0 ? d.models[mi] : undefined;
    const sessionId = session ?? d.s ?? undefined;
    const dir = cwd ?? d.c ?? undefined;
    return {
      at,
      tokens: { in: i, out: o, cacheRead: cr, cacheWrite: cw },
      ...(key !== null ? { key } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(dir !== undefined ? { cwd: dir } : {}),
      ...(cost !== null ? { costUsd: cost } : {}),
    };
  });
  return { mtimeMs: d.m, size: d.z, records };
}
/** entries for files not seen in a scan are kept this long, so a wider window later still hits */
const KEEP_MS = 120 * DAY_MS;

/**
 * Per-file parse cache (`<dataDir>/usage-index.json`): path → {mtime, size, records}. A file
 * whose mtime and size are unchanged is not re-read, so a warm scan of gigabytes of harness
 * logs reads only what was appended since. Records are the file's whole content (window
 * filtering happens after), so one index serves every window. Without a path it lives in memory.
 */
export class UsageIndex {
  readonly path: string | undefined;
  #entries = new Map<string, Entry>();
  #loaded = false;
  #dirty = false;

  constructor(path?: string) {
    this.path = path;
  }

  static pathFor(dataDir: string): string | undefined {
    return dataDir === ":memory:" ? undefined : join(dataDir, "usage-index.json");
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (this.path === undefined) return;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { version?: number; files?: Record<string, DiskEntry> };
      if (raw.version !== VERSION || raw.files === undefined) return;
      for (const [p, e] of Object.entries(raw.files)) this.#entries.set(p, fromDisk(e));
    } catch {
      // absent or corrupt: start empty, the next save rewrites it
    }
  }

  get(path: string, mtimeMs: number, size: number): FileRecord[] | undefined {
    const e = this.#entries.get(path);
    return e !== undefined && e.mtimeMs === mtimeMs && e.size === size ? e.records : undefined;
  }

  put(path: string, mtimeMs: number, size: number, records: FileRecord[]): void {
    this.#entries.set(path, { mtimeMs, size, records });
    this.#dirty = true;
  }

  get size(): number {
    return this.#entries.size;
  }

  async save(now = Date.now()): Promise<void> {
    for (const [p, e] of this.#entries) {
      if (e.mtimeMs < now - KEEP_MS) {
        this.#entries.delete(p);
        this.#dirty = true;
      }
    }
    if (!this.#dirty || this.path === undefined) return;
    this.#dirty = false;
    const files: Record<string, DiskEntry> = {};
    for (const [p, e] of this.#entries) files[p] = toDisk(e);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: VERSION, files }), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
