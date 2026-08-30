import { useEffect } from "react";
import { create } from "zustand";
import type { FsChange, FsEntry } from "@tide/contracts";
import { call, stream, type StreamControl } from "./model.ts";
import { showToast } from "./toast.ts";

export interface Entry<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

export interface FileIndex {
  paths: string[];
  truncated: boolean;
}

interface FilesState {
  /** `threadId:dirPath` → directory listing ("" is the thread root) */
  dirs: Record<string, Entry<FsEntry[]>>;
  /** `threadId:dirPath` of every expanded directory */
  expanded: Record<string, boolean>;
  /** threadId → flat recursive path list backing ⌘P and @mentions */
  indexes: Record<string, Entry<FileIndex>>;
  /** threadId → selected tree row path */
  selected: Record<string, string | undefined>;
}

export const useFiles = create<FilesState>(() => ({ dirs: {}, expanded: {}, indexes: {}, selected: {} }));

export function dirKey(threadId: string, path: string): string {
  return `${threadId}:${path}`;
}

export function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Directories first, then files, each case-insensitively by name. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "dir";
    const bDir = b.kind === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function patchDir(key: string, entry: Entry<FsEntry[]>): void {
  useFiles.setState((s) => ({ dirs: { ...s.dirs, [key]: entry } }));
}

async function loadDir(threadId: string, path: string): Promise<void> {
  const key = dirKey(threadId, path);
  const previous = useFiles.getState().dirs[key]?.data;
  patchDir(key, previous === undefined ? { loading: true } : { loading: true, data: previous });
  try {
    const result = await call("fs.list", { threadId, ...(path === "" ? {} : { path }) });
    patchDir(key, { loading: false, data: sortEntries(result.entries) });
  } catch (error) {
    patchDir(key, { loading: false, error: message(error) });
  }
}

/** Lazy directory read; `force` refetches a directory that is already cached. */
export function ensureDir(threadId: string, path: string, force = false): void {
  const entry = useFiles.getState().dirs[dirKey(threadId, path)];
  if (!force && entry && (entry.loading || entry.data !== undefined || entry.error !== undefined)) return;
  void loadDir(threadId, path);
}

export function isExpanded(threadId: string, path: string): boolean {
  return useFiles.getState().expanded[dirKey(threadId, path)] === true;
}

export function setExpanded(threadId: string, path: string, open: boolean): void {
  useFiles.setState((s) => ({ expanded: { ...s.expanded, [dirKey(threadId, path)]: open } }));
  if (open) ensureDir(threadId, path);
}

export function toggleExpanded(threadId: string, path: string): void {
  setExpanded(threadId, path, !isExpanded(threadId, path));
}

export function selectRow(threadId: string, path: string | undefined): void {
  useFiles.setState((s) => ({ selected: { ...s.selected, [threadId]: path } }));
}

// ---- mutations ----

export async function createEntry(threadId: string, path: string, kind: "file" | "dir"): Promise<boolean> {
  try {
    await call("fs.create", { threadId, path, kind });
    ensureDir(threadId, parentDir(path), true);
    invalidateIndex(threadId);
    return true;
  } catch (error) {
    showToast(`Create failed: ${message(error)}`);
    return false;
  }
}

export async function renameEntry(threadId: string, from: string, to: string): Promise<boolean> {
  try {
    await call("fs.rename", { threadId, from, to });
    ensureDir(threadId, parentDir(from), true);
    if (parentDir(to) !== parentDir(from)) ensureDir(threadId, parentDir(to), true);
    invalidateIndex(threadId);
    return true;
  } catch (error) {
    showToast(`Rename failed: ${message(error)}`);
    return false;
  }
}

export async function deleteEntry(threadId: string, path: string): Promise<boolean> {
  try {
    await call("fs.delete", { threadId, path });
    ensureDir(threadId, parentDir(path), true);
    invalidateIndex(threadId);
    return true;
  } catch (error) {
    showToast(`Delete failed: ${message(error)}`);
    return false;
  }
}

// ---- fs.watch fan-out: one server stream per thread, many listeners ----

type ChangeListener = (change: FsChange) => void;

interface Watcher {
  control: StreamControl;
  listeners: Set<ChangeListener>;
}

const watchers = new Map<string, Watcher>();

function onChange(threadId: string, change: FsChange): void {
  const dir = parentDir(change.path);
  const key = dirKey(threadId, dir);
  const state = useFiles.getState();
  if (state.dirs[key]?.data !== undefined) void loadDir(threadId, dir);
  invalidateIndex(threadId);
  const watcher = watchers.get(threadId);
  if (!watcher) return;
  for (const listener of [...watcher.listeners]) listener(change);
}

/**
 * Subscribes to the thread's change stream. The first subscriber opens it; the
 * last one to leave closes it. Every change refreshes the affected directory.
 */
export function subscribeWatch(threadId: string, listener?: ChangeListener): () => void {
  let watcher = watchers.get(threadId);
  if (!watcher) {
    const listeners = new Set<ChangeListener>();
    const control = stream("fs.watch", { threadId }, (change) => onChange(threadId, change));
    control.done.catch(() => undefined);
    watcher = { control, listeners };
    watchers.set(threadId, watcher);
  }
  const entry = watcher;
  if (listener) entry.listeners.add(listener);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (listener) entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && watchers.get(threadId) === entry) {
      watchers.delete(threadId);
      entry.control.cancel();
    }
  };
}

/** Keeps a watch open for as long as the component is mounted. */
export function useFsWatch(threadId: string | undefined, listener?: ChangeListener): void {
  useEffect(() => {
    if (!threadId) return undefined;
    return subscribeWatch(threadId, listener);
  }, [threadId, listener]);
}

// ---- recursive index for ⌘P / @mentions ----

const INDEX_LIMIT = 20_000;
const WALK_CONCURRENCY = 8;

function patchIndex(threadId: string, entry: Entry<FileIndex>): void {
  useFiles.setState((s) => ({ indexes: { ...s.indexes, [threadId]: entry } }));
}

export function invalidateIndex(threadId: string): void {
  useFiles.setState((s) => {
    if (!s.indexes[threadId]) return s;
    const indexes = { ...s.indexes };
    delete indexes[threadId];
    return { indexes };
  });
}

async function walk(threadId: string): Promise<FileIndex> {
  const paths: string[] = [];
  let queue: string[] = [""];
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    const batch = queue.splice(0, WALK_CONCURRENCY);
    const listings = await Promise.all(
      batch.map((dir) =>
        call("fs.list", { threadId, ...(dir === "" ? {} : { path: dir }) })
          .then((r) => r.entries)
          .catch(() => [] as FsEntry[]),
      ),
    );
    const next: string[] = [];
    for (const entries of listings) {
      for (const entry of entries) {
        if (entry.ignored) continue;
        if (entry.kind === "dir") next.push(entry.path);
        else paths.push(entry.path);
        if (paths.length >= INDEX_LIMIT) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    queue = [...queue, ...next];
  }
  paths.sort();
  return { paths, truncated };
}

export function ensureIndex(threadId: string, force = false): void {
  const entry = useFiles.getState().indexes[threadId];
  if (!force && entry && (entry.loading || entry.data !== undefined)) return;
  patchIndex(threadId, { loading: true });
  walk(threadId)
    .then((data) => patchIndex(threadId, { loading: false, data }))
    .catch((error: unknown) => patchIndex(threadId, { loading: false, error: message(error) }));
}

/** The thread's file index, walked on first use and after any fs mutation. */
export function useFileIndex(threadId: string | undefined): Entry<FileIndex> {
  const entry = useFiles((s) => (threadId ? s.indexes[threadId] : undefined));
  useEffect(() => {
    if (threadId) ensureIndex(threadId);
  }, [threadId, entry === undefined]);
  return entry ?? { loading: Boolean(threadId) };
}

export function resetFiles(): void {
  for (const [, watcher] of watchers) watcher.control.cancel();
  watchers.clear();
  useFiles.setState({ dirs: {}, expanded: {}, indexes: {}, selected: {} });
}
