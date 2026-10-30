import type { ProviderKind } from "@tide/contracts";
import { BucketSet, type Bucket } from "./buckets.ts";
import type { UsageIndex } from "./index.ts";
import { scanClaude } from "./ingest/claude.ts";
import { scanCodex } from "./ingest/codex.ts";
import { excluder, type Exclusion } from "./ingest/dedupe.ts";
import { scanOpencode } from "./ingest/opencode.ts";
import { scanPi } from "./ingest/pi.ts";
import { emptyStats, type Ingester, type ScanStats } from "./types.ts";

export interface ExternalResult {
  buckets: Bucket[];
  notes: string[];
}

export const INGESTERS: readonly (readonly [ProviderKind, string, Ingester])[] = [
  ["claude", "Claude Code", scanClaude],
  ["codex", "Codex", scanCodex],
  ["opencode", "OpenCode", scanOpencode],
  ["pi", "Pi", scanPi],
];

export interface ExternalScanOptions {
  home: string;
  since: number;
  until: number;
  exclusion: Exclusion;
  index?: UsageIndex;
  tmpDir?: string;
  ingesters?: readonly (readonly [ProviderKind, string, Ingester])[];
}

const fmt = (n: number): string => n.toLocaleString("en-US");

function describe(label: string, s: ScanStats, unit: string): string | undefined {
  const files = s.filesScanned + s.filesFromIndex;
  if (files === 0 && s.records === 0 && s.excluded === 0 && s.skipped.length === 0) return undefined;
  const parts = [`${label}: ${fmt(files)} log file${files === 1 ? "" : "s"} read`];
  if (s.filesFromIndex > 0) parts[0] += ` (${fmt(s.filesFromIndex)} unchanged, from the index)`;
  parts.push(`${fmt(s.records)} ${unit}`);
  if (s.excluded > 0) parts.push(`${fmt(s.excluded)} from Tide's own sessions left out (already counted as Tide)`);
  if (s.skipped.length > 0) parts.push(`${s.skipped.length} file${s.skipped.length === 1 ? "" : "s"} over 50 MB skipped`);
  return parts.join(", ") + ".";
}

/** Reads every harness's local logs for the window, minus Tide's own sessions, into day buckets. */
export async function scanExternal(options: ExternalScanOptions): Promise<ExternalResult> {
  const buckets = new BucketSet();
  const notes: string[] = [];
  const exclude = excluder(options.exclusion);
  const quiet: string[] = [];
  for (const [provider, label, scan] of options.ingesters ?? INGESTERS) {
    const stats = emptyStats();
    try {
      for await (const r of scan({
        home: options.home,
        since: options.since,
        until: options.until,
        exclude,
        stats,
        ...(options.index !== undefined ? { index: options.index } : {}),
        ...(options.tmpDir !== undefined ? { tmpDir: options.tmpDir } : {}),
      })) {
        buckets.add({ at: r.at, provider, model: r.model, source: "external", tokens: r.tokens, costUsd: r.costUsd });
      }
    } catch (err) {
      notes.push(`${label} logs could not be read: ${err instanceof Error ? err.message : String(err)}.`);
      continue;
    }
    const line = describe(label, stats, provider === "opencode" ? "sessions" : "model calls");
    if (line === undefined) quiet.push(label);
    else notes.push(line);
    notes.push(...stats.notes);
  }
  if (quiet.length > 0) notes.push(`No local logs in this window for ${quiet.join(", ")}.`);
  await options.index?.save().catch(() => undefined);
  return { buckets: buckets.list(), notes };
}

/** Five-minute memo per window key, with in-flight sharing so two page loads scan once. */
export class ExternalCache {
  readonly ttlMs: number;
  readonly #now: () => number;
  #entries = new Map<string, { at: number; value: Promise<ExternalResult> }>();

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  get(key: string, compute: () => Promise<ExternalResult>): Promise<ExternalResult> {
    const now = this.#now();
    for (const [k, e] of this.#entries) if (now - e.at > this.ttlMs) this.#entries.delete(k);
    const hit = this.#entries.get(key);
    if (hit) return hit.value;
    const value = compute();
    this.#entries.set(key, { at: now, value });
    value.catch(() => this.#entries.delete(key));
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }
}
