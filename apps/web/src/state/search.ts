import { create } from "zustand";
import type { SearchMatch } from "@tide/contracts";
import { call } from "./model.ts";

export interface SearchQuery {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  glob: string;
}

export interface SearchResults {
  matches: SearchMatch[];
  truncated: boolean;
}

interface SearchState {
  queries: Record<string, SearchQuery>;
  results: Record<string, { data?: SearchResults; error?: string; loading: boolean }>;
}

export const EMPTY_QUERY: SearchQuery = { query: "", regex: false, caseSensitive: false, glob: "" };
export const DEBOUNCE_MS = 200;
const LIMIT = 500;

export const useSearch = create<SearchState>(() => ({ queries: {}, results: {} }));

export function useSearchQuery(threadId: string): SearchQuery {
  return useSearch((s) => s.queries[threadId]) ?? EMPTY_QUERY;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const generation = new Map<string, number>();

function run(threadId: string, query: SearchQuery): void {
  const seq = (generation.get(threadId) ?? 0) + 1;
  generation.set(threadId, seq);
  if (query.query.trim() === "") {
    useSearch.setState((s) => ({ results: { ...s.results, [threadId]: { loading: false } } }));
    return;
  }
  useSearch.setState((s) => ({ results: { ...s.results, [threadId]: { loading: true } } }));
  call("fs.search", {
    threadId,
    query: query.query,
    limit: LIMIT,
    ...(query.regex ? { regex: true } : {}),
    ...(query.caseSensitive ? { caseSensitive: true } : {}),
    ...(query.glob.trim() === "" ? {} : { glob: query.glob.trim() }),
  })
    .then((data) => {
      if (generation.get(threadId) !== seq) return;
      useSearch.setState((s) => ({ results: { ...s.results, [threadId]: { loading: false, data } } }));
    })
    .catch((error: unknown) => {
      if (generation.get(threadId) !== seq) return;
      const text = error instanceof Error ? error.message : String(error);
      useSearch.setState((s) => ({ results: { ...s.results, [threadId]: { loading: false, error: text } } }));
    });
}

/** Updates the query and schedules a debounced `fs.search`. */
export function setSearchQuery(threadId: string, patch: Partial<SearchQuery>): void {
  const next = { ...(useSearch.getState().queries[threadId] ?? EMPTY_QUERY), ...patch };
  useSearch.setState((s) => ({ queries: { ...s.queries, [threadId]: next } }));
  const timer = timers.get(threadId);
  if (timer !== undefined) clearTimeout(timer);
  timers.set(
    threadId,
    setTimeout(() => {
      timers.delete(threadId);
      run(threadId, next);
    }, DEBOUNCE_MS),
  );
}

export function runSearchNow(threadId: string): void {
  const timer = timers.get(threadId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(threadId);
  }
  run(threadId, useSearch.getState().queries[threadId] ?? EMPTY_QUERY);
}

export interface SearchGroup {
  path: string;
  matches: SearchMatch[];
}

/** Results grouped by file, in first-hit order. */
export function groupMatches(matches: SearchMatch[]): SearchGroup[] {
  const byPath = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = byPath.get(match.path);
    if (list) list.push(match);
    else byPath.set(match.path, [match]);
  }
  return [...byPath].map(([path, list]) => ({ path, matches: list }));
}

export function resetSearch(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  generation.clear();
  useSearch.setState({ queries: {}, results: {} });
}
