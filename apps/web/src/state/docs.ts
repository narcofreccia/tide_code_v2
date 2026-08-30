import { create } from "zustand";
import { call } from "./model.ts";
import { showToast } from "./toast.ts";
import { subscribeWatch } from "./files.ts";

export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

export interface Doc {
  loading: boolean;
  error?: string;
  /** current buffer; undefined while loading or when not editable */
  content?: string;
  /** what the last read/write saw on disk — the dirty baseline */
  saved?: string;
  mtime?: number;
  size?: number;
  binary?: boolean;
  tooLarge?: boolean;
  saving?: boolean;
  /** disk moved under a dirty buffer, or `fs.write` came back `conflict` */
  conflict?: boolean;
}

interface DocsState {
  docs: Record<string, Doc>;
}

export const useDocs = create<DocsState>(() => ({ docs: {} }));

export function docKey(threadId: string, path: string): string {
  return `${threadId}:${path}`;
}

type DocPatch = { [K in keyof Doc]?: Doc[K] | undefined };

function patch(key: string, next: DocPatch): void {
  useDocs.setState((s) => {
    // the patch may carry explicit `undefined`s (clearing an error); the merge is exact
    const merged = { ...(s.docs[key] ?? { loading: false }), ...next } as Doc;
    return { docs: { ...s.docs, [key]: merged } };
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflict(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "conflict" || /conflict/i.test(message(error));
}

export function isDirty(doc: Doc | undefined): boolean {
  return doc?.content !== undefined && doc.saved !== undefined && doc.content !== doc.saved;
}

export function useDoc(threadId: string | undefined, path: string | undefined): Doc | undefined {
  return useDocs((s) => (threadId && path ? s.docs[docKey(threadId, path)] : undefined));
}

/** Dirty flag for the tab strip; never triggers a read. */
export function useIsDirty(threadId: string | undefined, path: string): boolean {
  return useDocs((s) => isDirty(threadId ? s.docs[docKey(threadId, path)] : undefined));
}

async function read(threadId: string, path: string, keepBuffer: boolean): Promise<void> {
  const key = docKey(threadId, path);
  patch(key, { loading: true, error: undefined });
  try {
    const result = await call("fs.read", { threadId, path });
    const tooLarge = result.size > MAX_EDITABLE_BYTES;
    const content = result.binary || tooLarge ? undefined : (result.content ?? "");
    patch(key, {
      loading: false,
      binary: result.binary,
      tooLarge,
      size: result.size,
      mtime: result.mtime,
      saved: content,
      conflict: false,
      ...(keepBuffer ? {} : { content }),
    });
  } catch (error) {
    patch(key, { loading: false, error: message(error) });
  }
}

/** Reads a file once per tab; `force` re-reads it (Reload button, external change). */
export function ensureDoc(threadId: string, path: string, force = false): void {
  const doc = useDocs.getState().docs[docKey(threadId, path)];
  if (!force && doc && (doc.loading || doc.saved !== undefined || doc.error !== undefined || doc.binary)) return;
  void read(threadId, path, false);
}

export function editDoc(threadId: string, path: string, content: string): void {
  patch(docKey(threadId, path), { content });
}

export function reloadDoc(threadId: string, path: string): void {
  void read(threadId, path, false);
}

/** ⌘S. Optimistic concurrency unless the user chose to overwrite. */
export async function saveDoc(threadId: string, path: string, overwrite = false): Promise<boolean> {
  const key = docKey(threadId, path);
  const doc = useDocs.getState().docs[key];
  if (!doc || doc.content === undefined || doc.saving) return false;
  patch(key, { saving: true });
  try {
    const result = await call("fs.write", {
      threadId,
      path,
      content: doc.content,
      ...(overwrite || doc.mtime === undefined ? {} : { ifMtime: doc.mtime }),
    });
    patch(key, { saving: false, saved: doc.content, mtime: result.mtime, conflict: false });
    return true;
  } catch (error) {
    patch(key, { saving: false, ...(isConflict(error) ? { conflict: true } : {}) });
    if (!isConflict(error)) showToast(`Save failed: ${message(error)}`);
    return false;
  }
}

export function closeDoc(threadId: string, path: string): void {
  const key = docKey(threadId, path);
  useDocs.setState((s) => {
    if (!s.docs[key]) return s;
    const docs = { ...s.docs };
    delete docs[key];
    return { docs };
  });
  viewStates.delete(key);
}

/**
 * Watches the thread for external writes: a clean buffer reloads silently, a
 * dirty one raises the conflict banner instead of losing the user's edits.
 */
export function watchDocs(threadId: string): () => void {
  return subscribeWatch(threadId, (change) => {
    const key = docKey(threadId, change.path);
    const doc = useDocs.getState().docs[key];
    if (!doc) return;
    if (change.kind === "deleted") {
      patch(key, { error: "Deleted on disk" });
      return;
    }
    if (isDirty(doc)) patch(key, { conflict: true });
    else void read(threadId, change.path, false);
  });
}

// ---- per-tab Monaco view state (cursor + scroll), memory only ----

const viewStates = new Map<string, unknown>();

export function saveViewState(threadId: string, path: string, state: unknown): void {
  viewStates.set(docKey(threadId, path), state);
}

export function loadViewState(threadId: string, path: string): unknown {
  return viewStates.get(docKey(threadId, path));
}

export function resetDocs(): void {
  useDocs.setState({ docs: {} });
  viewStates.clear();
}
