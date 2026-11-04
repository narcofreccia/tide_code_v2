import { useEffect } from "react";
import { create } from "zustand";
import { selectCheckpointTurns, selectThreadTurns } from "@tide/client";
import type { CommitSummary, DiffResult, ReadModel, VcsStatus } from "@tide/contracts";
import { call, useModel } from "./model.ts";
import { showToast } from "./toast.ts";
import { diffTotals, type DiffTotals } from "../lib/diffStats.ts";
import { CHANGES_TAB, openFileTab, setActiveTab } from "./workbench.ts";

/** `"all"` means the whole-thread diff (`vcs.threadDiff`); `commit:<sha>` a commit (`vcs.commitDiff`). */
export type TurnSelection = string;
export const ALL_CHANGES = "all";
const COMMIT_PREFIX = "commit:";

export function commitSelection(sha: string): TurnSelection {
  return `${COMMIT_PREFIX}${sha}`;
}
export function isCommitSelection(selection: TurnSelection | undefined): boolean {
  return selection !== undefined && selection.startsWith(COMMIT_PREFIX) && selection.length > COMMIT_PREFIX.length;
}
export function commitSha(selection: TurnSelection): string | undefined {
  return isCommitSelection(selection) ? selection.slice(COMMIT_PREFIX.length) : undefined;
}

export interface CommitList {
  branch?: string;
  commits: CommitSummary[];
}

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
  commits: Record<string, Entry<CommitList>>;
  /** the file the Changes tab shows, per thread; absent means "the first one" */
  pickedFile: Record<string, string | undefined>;
}

const INITIAL: VcsState = { diffs: {}, statuses: {}, selection: {}, commits: {}, pickedFile: {} };
export const useVcs = create<VcsState>(() => INITIAL);

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

/** Bumped by `invalidateThread`; a response that started under an older value is stale and dropped. */
const generations = new Map<string, number>();
const generationOf = (threadId: string): number => generations.get(threadId) ?? 0;

async function loadDiff(threadId: string, turnId: TurnSelection): Promise<void> {
  const key = diffKey(threadId, turnId);
  const generation = generationOf(threadId);
  patchDiff(key, { loading: true });
  try {
    const sha = commitSha(turnId);
    const data =
      sha !== undefined
        ? await call("vcs.commitDiff", { threadId, sha })
        : turnId === ALL_CHANGES
          ? await call("vcs.threadDiff", { threadId })
          : await call("vcs.turnDiff", { threadId, turnId });
    if (generation !== generationOf(threadId)) return;
    patchDiff(key, { loading: false, data });
  } catch (error) {
    if (generation !== generationOf(threadId)) return;
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
    // a refreshed status means git moved (commit, merge, checkout): the commit list is stale too
    if (useVcs.getState().commits[threadId] !== undefined) ensureCommits(threadId, true);
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

async function loadCommits(threadId: string): Promise<void> {
  const patch = (entry: Entry<CommitList>): void =>
    useVcs.setState((s) => ({ commits: { ...s.commits, [threadId]: entry } }));
  const previous = useVcs.getState().commits[threadId]?.data;
  patch({ loading: true, ...(previous === undefined ? {} : { data: previous }) });
  try {
    patch({ loading: false, data: await call("vcs.commits", { threadId, limit: 50 }) });
  } catch (error) {
    patch({ loading: false, error: message(error) });
  }
}

export function ensureCommits(threadId: string, force = false): void {
  const entry = useVcs.getState().commits[threadId];
  if (!force && entry && (entry.loading || entry.data !== undefined || entry.error !== undefined)) return;
  void loadCommits(threadId);
}

/** Drops every cached diff of a thread so the next read refetches. */
export function invalidateThread(threadId: string): void {
  generations.set(threadId, generationOf(threadId) + 1);
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

export function pickFile(threadId: string, path: string | undefined): void {
  useVcs.setState((s) => ({ pickedFile: { ...s.pickedFile, [threadId]: path } }));
}

/**
 * "View diff" on an edit row: the turn's own diff with the file picked in the Changes tab when
 * the turn has a checkpoint (or is still running, so Changes follows it live); otherwise the
 * best available is the file itself in the editor.
 */
export function openChangesForFile(threadId: string, turnId: string, path: string): void {
  const turn = useModel.getState().model.turns[turnId];
  const live = turn !== undefined && (turn.status === "requested" || turn.status === "running");
  if (turn === undefined || (turn.checkpoint === undefined && !live)) {
    openFileTab(threadId, path);
    return;
  }
  selectTurn(threadId, turnId);
  pickFile(threadId, path);
  setActiveTab(threadId, CHANGES_TAB);
}

export function resetVcs(): void {
  useVcs.setState(INITIAL);
  signatures.clear();
  generations.clear();
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
  if (explicit === ALL_CHANGES || isCommitSelection(explicit)) return explicit;
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
  return `${turn.status}|${turn.settledAt ?? ""}|${cp?.before ?? ""}|${cp?.after ?? ""}|${cp?.stats?.files ?? ""}|${cp?.stats?.additions ?? ""}|${cp?.stats?.deletions ?? ""}`;
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

// streaming deltas replace messages, never turns: skip the per-turn walk until turns change
useModel.subscribe((state, prev) => {
  if (state.model.turns !== prev.model.turns) onModelChange(state.model);
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

export interface CommitsQuery extends Entry<CommitList> {
  refresh: () => void;
}

/** The thread branch's newest commits; fetched when first asked for, then kept fresh by status refreshes. */
export function useCommits(threadId: string | undefined, enabled = true): CommitsQuery {
  const entry = useVcs((s) => (threadId ? s.commits[threadId] : undefined));
  useEffect(() => {
    if (threadId && enabled) ensureCommits(threadId);
  }, [threadId, enabled, entry === undefined]);
  return {
    loading: entry?.loading ?? Boolean(threadId && enabled),
    ...(entry?.data === undefined ? {} : { data: entry.data }),
    ...(entry?.error === undefined ? {} : { error: entry.error }),
    refresh: () => {
      if (threadId) ensureCommits(threadId, true);
    },
  };
}

/** `+n −m` for the turn the Changes tab is showing; read-only, never fetches. */
export function useSelectedDiffStats(threadId: string | undefined): DiffTotals | undefined {
  const explicit = useVcs((s) => (threadId ? s.selection[threadId] : undefined));
  // narrow subscriptions: a string and one turn, both stable across streaming deltas
  const selection = useModel((s) => (threadId ? resolveSelection(s.model, threadId, explicit) : undefined));
  const turn = useModel((s) => (selection === undefined || selection === ALL_CHANGES || isCommitSelection(selection) ? undefined : s.model.turns[selection]));
  const entry = useVcs((s) => (threadId && selection ? s.diffs[diffKey(threadId, selection)] : undefined));
  if (!threadId || selection === undefined) return undefined;
  return diffTotals(turn, entry?.data);
}
