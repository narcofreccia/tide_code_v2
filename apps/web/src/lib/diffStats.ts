import type { DiffResult, Turn } from "@tide/contracts";

export interface DiffTotals {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * One entry per path, keeping the last one seen. A diff re-read while a turn is
 * still writing can report the same path twice (e.g. added, then modified).
 */
export function uniqueByPath<T extends { path: string }>(files: readonly T[]): T[] {
  const byPath = new Map<string, T>();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()];
}

/**
 * The `+n −m` every surface shows for one selection: the turn's own checkpoint
 * stats when it has them (the same figure the turn list shows), else the loaded
 * diff summed over the rows the file list shows (whole thread, or a turn still
 * running).
 */
export function diffTotals(turn: Turn | undefined, diff: DiffResult | undefined): DiffTotals | undefined {
  const stats = turn?.checkpoint?.stats;
  if (stats) return { additions: stats.additions, deletions: stats.deletions, files: stats.files };
  if (!diff) return undefined;
  const files = uniqueByPath(diff.files);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions, files: files.length };
}
