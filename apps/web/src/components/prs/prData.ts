import { create } from "zustand";
import type { PrListItem } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { callTargets } from "../../lib/envTargets.ts";

/** A listed PR tagged with the environment that answered for it. */
export interface PrEntry extends PrListItem {
  /** undefined when the client runs against one server without an environment list */
  envId?: string;
  /** stable across refreshes: env + project + number */
  key: string;
}

export const entryKey = (envId: string | undefined, projectId: string, number: number): string =>
  `${envId ?? ""}|${projectId}|${number}`;

interface PrsState {
  items: PrEntry[];
  /** the forge user per environment (`""` for the single-server case) */
  viewers: Record<string, string>;
  fetchedAt: number | undefined;
  loading: boolean;
  /** one line per environment that failed */
  errors: string[];
  /** "open" or "all", as last requested */
  scope: "open" | "all";
}

export const usePrs = create<PrsState>(() => ({
  items: [],
  viewers: {},
  fetchedAt: undefined,
  loading: false,
  errors: [],
  scope: "open",
}));

export function resetPrs(): void {
  usePrs.setState({ items: [], viewers: {}, fetchedAt: undefined, loading: false, errors: [], scope: "open" });
}

let generation = 0;

/** `pr.list` on every connected environment, merged. A later call wins over an earlier one still in flight. */
export async function loadPrs(opts: { state?: "open" | "all"; refresh?: boolean } = {}): Promise<void> {
  const scope = opts.state ?? usePrs.getState().scope;
  const mine = ++generation;
  usePrs.setState({ loading: true, scope });
  const params = { state: scope, ...(opts.refresh === true ? { refresh: true } : {}) };
  const results = await Promise.all(
    callTargets().map(async (envId) => {
      try {
        const out = await (envId === undefined ? call("pr.list", params) : call("pr.list", params, { envId }));
        return { envId, out };
      } catch (error) {
        return { envId, error: errorText(error) };
      }
    }),
  );
  if (mine !== generation) return;
  const items: PrEntry[] = [];
  const viewers: Record<string, string> = {};
  const errors: string[] = [];
  let fetchedAt: number | undefined;
  for (const result of results) {
    if ("error" in result) {
      errors.push(result.error ?? "unknown error");
      continue;
    }
    const { envId, out } = result;
    if (out.viewer !== undefined) viewers[envId ?? ""] = out.viewer;
    fetchedAt = Math.max(fetchedAt ?? 0, out.fetchedAt);
    for (const item of out.items) {
      items.push({ ...item, ...(envId === undefined ? {} : { envId }), key: entryKey(envId, item.projectId, item.pr.number) });
    }
  }
  usePrs.setState({ items, viewers, fetchedAt, loading: false, errors });
}

/** Routing for a call about one PR: its environment when tagged. */
export function routeOf(entry: { envId?: string }): { envId: string } | undefined {
  return entry.envId === undefined ? undefined : { envId: entry.envId };
}
