import { create } from "zustand";
import type { ReadModel, SearchHit, Thread } from "@tide/contracts";
import { call } from "./model.ts";
import { callTargets } from "../lib/envTargets.ts";
import { PROVIDER_LABELS } from "../lib/vocab.ts";

/**
 * R12 rail search: an instant local filter over what the read model already holds
 * (title, project, harness), then `threads.search` on the server for message text
 * once the query has two characters, debounced. Per session, never persisted.
 */
export const SERVER_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;

interface RailSearchState {
  query: string;
  /** server hits for `hitsFor` (query + scope); stale ones are ignored by the merge */
  hits: SearchHit[];
  hitsFor: string;
  loading: boolean;
}

export const useRailSearch = create<RailSearchState>(() => ({ query: "", hits: [], hitsFor: "", loading: false }));

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

export function resetRailSearch(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  generation++;
  useRailSearch.setState({ query: "", hits: [], hitsFor: "", loading: false });
}

const keyOf = (q: string, projectId: string | null): string => `${projectId ?? ""}\n${q.trim().toLowerCase()}`;

/** Every connected environment answers; hits are merged newest first, one per thread. */
export async function searchServer(q: string, projectId: string | null): Promise<SearchHit[]> {
  const params = { q, ...(projectId === null ? {} : { projectId }) };
  const results = await Promise.all(
    callTargets().map(async (envId) => {
      try {
        const out = await (envId === undefined ? call("threads.search", params) : call("threads.search", params, { envId }));
        return out.hits;
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  return results
    .flat()
    .sort((a, b) => b.at - a.at)
    .filter((hit) => (seen.has(hit.threadId) ? false : (seen.add(hit.threadId), true)));
}

/** Sets the query; schedules the server search when it is long enough. */
export function setRailQuery(query: string, projectId: string | null): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  const mine = ++generation;
  const q = query.trim();
  if (q.length < SERVER_MIN_CHARS) {
    useRailSearch.setState({ query, hits: [], hitsFor: "", loading: false });
    return;
  }
  useRailSearch.setState({ query, loading: true });
  timer = setTimeout(() => {
    timer = undefined;
    void searchServer(q, projectId).then((hits) => {
      if (mine !== generation) return;
      useRailSearch.setState({ hits, hitsFor: keyOf(q, projectId), loading: false });
    });
  }, SEARCH_DEBOUNCE_MS);
}

/** Substring match over title, project title and harness label; newest first. */
export function localMatches(model: ReadModel, query: string, projectIds: readonly string[]): Thread[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scope = new Set(projectIds);
  return Object.values(model.threads)
    .filter((t) => scope.has(t.projectId))
    .filter((t) => {
      const project = model.projects[t.projectId]?.title ?? "";
      const hay = `${t.title}\n${project}\n${PROVIDER_LABELS[t.provider]}\n${t.provider}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined) || b.updatedAt - a.updatedAt);
}

export interface SearchRow {
  thread: Thread;
  hit?: SearchHit;
}

/** Local matches first, then server hits for threads not already listed (and known to the model). */
export function mergeResults(
  model: ReadModel,
  local: readonly Thread[],
  state: Pick<RailSearchState, "hits" | "hitsFor">,
  query: string,
  projectId: string | null,
): SearchRow[] {
  const rows: SearchRow[] = local.map((thread) => ({ thread }));
  if (state.hitsFor !== keyOf(query.trim(), projectId)) return rows;
  const shown = new Set(local.map((t) => t.id));
  for (const hit of state.hits) {
    if (shown.has(hit.threadId)) continue;
    const thread = model.threads[hit.threadId];
    if (thread === undefined) continue;
    shown.add(hit.threadId);
    rows.push({ thread, hit });
  }
  return rows;
}
