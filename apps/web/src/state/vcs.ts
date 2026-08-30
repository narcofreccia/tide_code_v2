import { useEffect } from "react";
import { create } from "zustand";
import { selectCheckpointTurns, selectThreadTurns } from "@tide/client";
import type { DiffResult, ReadModel, VcsStatus } from "@tide/contracts";
import { call, useModel } from "./model.ts";
import { showToast } from "./toast.ts";

/** `"all"` means the whole-thread diff (`vcs.threadDiff`). */
export type TurnSelection = string;
export const ALL_CHANGES = "all";

export interface Entry<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

interface VcsState {
  /** keyed `threadId:turnId` (turnId may be `all`) */
  diffs: Record<string, Entry<DiffResult>>;
  statuses: Record<string, Entry<VcsStatus>>;
  /** explicit turn choice per thread; absent means "follow the latest checkpoint" */
  selection: Record<string, TurnSelection | undefined>;
}

export const useVcs = create<VcsState>(() => ({ diffs: {}, statuses: {}, selection: {} }));

export function diffKey(threadId: string, turnId: TurnSelection): string {
  return `${threadId}:${turnId}`;
}

function patchDiff(key: string, entry: Entry<DiffResult>): void {
  useVcs.setState((s) => ({ diffs: { ...s.diffs, [key]: entry } }));
}

function patchStatus(threadId: string, entry: Entry<VcsStatus>): void {
  useVcs.setState((s) => ({ statuses: { ...s.statuses, [threadId]: entry } }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadDiff(threadId: string, turnId: TurnSelection): Promise<void> {
  const key = diffKey(threadId, turnId);
  patchDiff(key, { loading: true });
  try {
    const data =
      turnId === ALL_CHANGES
        ? await call("vcs.threadDiff", { threadId })
        : await call("vcs.turnDiff", { threadId, turnId });
    patchDiff(key, { loading: false, data });
  } catch (error) {
    const text = message(error);
    patchDiff(key, { loading: false, error: text });
    showToast(`Diff failed: ${text}`);
  }
}

/** Fetches once per key; `force` bypasses the cache (manual refresh / invalidation). */
export function ensureDiff(threadId: string, turnId: TurnSelection, force = false): void {
  const entry = useVcs.getState().diffs[diffKey(threadId, turnId)];
  if (!force && entry && (entry.loading || entry.data !== undefined || entry.error !== undefined)) return;
  void loadDiff(threadId, turnId);
}

async function loadStatus(threadId: string): Promise<void> {
  patchStatus(threadId, { loading: true });
  try {
    patchStatus(threadId, { loading: false, data: await call("vcs.status", { threadId }) });
  } catch (error) {
    const text = message(error);
    patchStatus(threadId, { loading: false, error: text });
    showToast(`Git status failed: ${text}`);
  }
}

export function ensureStatus(threadId: string, force = false): void {
  const entry = useVcs.getState().statuses[threadId];
  if (!force && entry && (entry.loading || entry.data !== undefined || entry.error !== undefined)) return;
  void loadStatus(threadId);
}

/** Drops every cached diff of a thread so the next read refetches. */
export function invalidateThread(threadId: string): void {
  useVcs.setState((s) => {
    const diffs: Record<string, Entry<DiffResult>> = {};
    for (const [key, value] of Object.entries(s.diffs)) {
      if (!key.startsWith(`${threadId}:`)) diffs[key] = value;
    }
    return { diffs };
  });
}

export function selectTurn(threadId: string, turnId: TurnSelection | undefined): void {
  useVcs.setState((s) => ({ selection: { ...s.selection, [threadId]: turnId } }));
}

export function resetVcs(): void {
  useVcs.setState({ diffs: {}, statuses: {}, selection: {} });
  signatures.clear();
}

/**
 * The turn whose diff the Changes tab shows: the user's pick when it still
 * exists, else the newest turn with a checkpoint, else the turn in flight.
 */
export function resolveSelection(
  model: ReadModel,
  threadId: string,
  explicit: TurnSelection | undefined,
): TurnSelection | undefined {
  const turns = selectThreadTurns(model, threadId);
  if (explicit === ALL_CHANGES) return ALL_CHANGES;
  if (explicit !== undefined && turns.some((t) => t.id === explicit)) return explicit;
  const checkpoints = selectCheckpointTurns(model, threadId);
  const latest = checkpoints[checkpoints.length - 1] ?? turns[turns.length - 1];
  return latest?.id;
}

// ---- invalidation: a settled turn or a fresh checkpoint changes the diff ----

const signatures = new Map<string, string>();

function turnSignature(model: ReadModel, turnId: string): string {
  const turn = model.turns[turnId];
  if (!turn) return "";
  const cp = turn.checkpoint;
  return `${turn.status}|${turn.settledAt ?? ""}|${cp?.before ?? ""}|${cp?.after ?? ""}|${cp?.stats?.files ?? ""}`;
}

function onModelChange(model: ReadModel): void {
  const stale = new Set<string>();
  for (const turn of Object.values(model.turns)) {
    const next = turnSignature(model, turn.id);
    if (signatures.get(turn.id) !== next) {
      if (signatures.has(turn.id)) stale.add(turn.threadId);
      signatures.set(turn.id, next);
    }
  }
  for (const threadId of stale) invalidateThread(threadId);
}

useModel.subscribe((state, prev) => {
  if (state.model !== prev.model) onModelChange(state.model);
});

// ---- hooks ----

export interface DiffQuery extends Entry<DiffResult> {
  refresh: () => void;
}

/** Cached diff for one turn (or `"all"`), fetched on demand and on invalidation. */
export function useTurnDiff(threadId: string | undefined, turnId: TurnSelection | undefined): DiffQuery {
  const key = threadId && turnId ? diffKey(threadId, turnId) : "";
  const entry = useVcs((s) => (key ? s.diffs[key] : undefined));
  useEffect(() => {
    if (threadId && turnId) ensureDiff(threadId, turnId);
  }, [threadId, turnId, entry === undefined]);
  return {
    loading: entry?.loading ?? Boolean(threadId && turnId),
    ...(entry?.data === undefined ? {} : { data: entry.data }),
    ...(entry?.error === undefined ? {} : { error: entry.error }),
    refresh: () => {
      if (threadId && turnId) ensureDiff(threadId, turnId, true);
    },
  };
}

export interface StatusQuery extends Entry<VcsStatus> {
  refresh: () => void;
}

export function useVcsStatus(threadId: string | undefined): StatusQuery {
  const entry = useVcs((s) => (threadId ? s.statuses[threadId] : undefined));
  useEffect(() => {
    if (threadId) ensureStatus(threadId);
  }, [threadId, entry === undefined]);
  return {
    loading: entry?.loading ?? Boolean(threadId),
    ...(entry?.data === undefined ? {} : { data: entry.data }),
    ...(entry?.error === undefined ? {} : { error: entry.error }),
    refresh: () => {
      if (threadId) ensureStatus(threadId, true);
    },
  };
}

/** `+n −m` for the turn the Changes tab is showing; read-only, never fetches. */
export function useSelectedDiffStats(threadId: string | undefined): { additions: number; deletions: number; files: number } | undefined {
  const explicit = useVcs((s) => (threadId ? s.selection[threadId] : undefined));
  const model = useModel((s) => s.model);
  const selection = threadId ? resolveSelection(model, threadId, explicit) : undefined;
  const entry = useVcs((s) => (threadId && selection ? s.diffs[diffKey(threadId, selection)] : undefined));
  if (entry?.data) {
    let additions = 0;
    let deletions = 0;
    for (const file of entry.data.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions, files: entry.data.files.length };
  }
  if (!threadId || selection === undefined || selection === ALL_CHANGES) return undefined;
  const stats = model.turns[selection]?.checkpoint?.stats;
  return stats ? { additions: stats.additions, deletions: stats.deletions, files: stats.files } : undefined;
}
