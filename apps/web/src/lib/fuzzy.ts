/**
 * Tiny subsequence matcher for path pickers (⌘P, @mentions). Scores favour
 * matches on the basename, consecutive runs and word/segment boundaries — the
 * heuristics that make `wbtabs` find `state/workbench/tabs.ts`.
 */
export interface FuzzyResult {
  score: number;
  /** indices in the candidate that matched, in order */
  positions: number[];
}

const BOUNDARY = /[/._\- ]/;

export function fuzzyMatch(query: string, candidate: string): FuzzyResult | undefined {
  if (query === "") return { score: 0, positions: [] };
  const needle = query.toLowerCase();
  const hay = candidate.toLowerCase();
  const positions: number[] = [];
  let at = 0;
  for (const ch of needle) {
    if (ch === " ") continue;
    const found = hay.indexOf(ch, at);
    if (found === -1) return undefined;
    positions.push(found);
    at = found + 1;
  }
  if (positions.length === 0) return { score: 0, positions: [] };

  const baseAt = candidate.lastIndexOf("/") + 1;
  let score = 0;
  let previous = -2;
  for (const index of positions) {
    if (index === previous + 1) score += 8;
    const before = index === 0 ? "/" : candidate[index - 1] ?? "";
    if (index === 0 || BOUNDARY.test(before)) score += 6;
    if (index >= baseAt) score += 4;
    score -= Math.min(4, index === previous + 1 ? 0 : index - previous - 1) * 0.5;
    previous = index;
  }
  // shorter candidates win ties; a full basename prefix is the best case
  score -= candidate.length * 0.05;
  if (hay.startsWith(needle)) score += 6;
  if (hay.slice(baseAt).startsWith(needle)) score += 10;
  return { score, positions };
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/** Ranks candidates, best first, keeping at most `limit`. */
export function fuzzyRank<T>(query: string, items: T[], key: (item: T) => string, limit = 50): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (!match) continue;
    out.push({ item, score: match.score, positions: match.positions });
  }
  out.sort((a, b) => b.score - a.score || key(a.item).length - key(b.item).length);
  return out.slice(0, limit);
}
