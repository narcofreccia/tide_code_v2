import type { ProviderKind } from "@tide/contracts";
import type { UsageIndex } from "./index.ts";

/** Token counts in one shape for every harness. `in` never includes cache reads (OpenAI-style totals are split at the source). */
export interface UsageTokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One billed model call (or, where a harness only keeps session totals, one session) read from a harness's own logs. */
export interface UsageRecord {
  provider: ProviderKind;
  model?: string;
  /** epoch ms */
  at: number;
  sessionId?: string;
  cwd?: string;
  tokens: UsageTokens;
  /** only when the harness itself wrote a cost */
  costUsd?: number;
}

/** What a scan read, so the summary's notes can say it in plain words. */
export interface ScanStats {
  filesScanned: number;
  /** files whose cached totals were reused (index hit) */
  filesFromIndex: number;
  records: number;
  excluded: number;
  skipped: string[];
  notes: string[];
}

export interface ScanOptions {
  /** the user's home directory (tests pass a temp dir) */
  home: string;
  since: number;
  until: number;
  /** records Tide itself ran (its sessions, its worktrees) */
  exclude?: (record: UsageRecord) => boolean;
  stats?: ScanStats;
  /** per-file parse cache shared across scans */
  index?: UsageIndex;
  /** scratch dir for copying a locked SQLite file */
  tmpDir?: string;
}

export type Ingester = (options: ScanOptions) => AsyncIterable<UsageRecord>;

export function emptyStats(): ScanStats {
  return { filesScanned: 0, filesFromIndex: 0, records: 0, excluded: 0, skipped: [], notes: [] };
}

export function zeroTokens(): UsageTokens {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const DAY_MS = 86_400_000;
