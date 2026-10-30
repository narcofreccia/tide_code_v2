import { create } from "zustand";
import { newId } from "@tide/contracts";

/** An image as held in a draft: the same base64 the composer sends. */
export interface SerializedImage {
  id: string;
  mediaType: string;
  data: string;
  bytes: number;
}

export interface Draft {
  text: string;
  images: SerializedImage[];
  updatedAt: number;
}

export interface StashedDraft extends Draft {
  id: string;
}

interface DraftsState {
  drafts: Record<string, Draft>;
  stash: StashedDraft[];
}

export const DRAFTS_STORAGE_KEY = "tide.drafts.v1";
const IDB_NAME = "tide-drafts";
const IDB_STORE = "images";
const DEBOUNCE_MS = 300;
/** Every image list lives in IndexedDB under `thread:<id>` or `stash:<id>`. */
const threadKey = (id: string): string => `thread:${id}`;
const stashKey = (id: string): string => `stash:${id}`;

const empty = (d: Draft): boolean => d.text.trim() === "" && d.images.length === 0;

// ---- IndexedDB: tiny key -> SerializedImage[] helper, silent on failure ----

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(undefined);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const idbPut = (key: string, images: SerializedImage[]): Promise<unknown> =>
  idbRun<unknown>("readwrite", (s) => (images.length === 0 ? s.delete(key) : s.put(images, key)) as IDBRequest<unknown>);
const idbGet = (key: string): Promise<SerializedImage[] | undefined> =>
  idbRun<SerializedImage[]>("readonly", (s) => s.get(key) as IDBRequest<SerializedImage[]>);

// ---- localStorage: text + metadata ----

interface Stored {
  drafts: Record<string, { text: string; updatedAt: number; images: number }>;
  stash: { id: string; text: string; updatedAt: number; images: number }[];
}

function readStored(): Stored | undefined {
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Stored;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let dirtyImages = new Set<string>();

/** Writes now; the debounce below calls this. Exported for tests. */
export function flushDrafts(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  const { drafts, stash } = useDrafts.getState();
  const stored: Stored = {
    drafts: Object.fromEntries(
      Object.entries(drafts).map(([id, d]) => [id, { text: d.text, updatedAt: d.updatedAt, images: d.images.length }]),
    ),
    stash: stash.map((d) => ({ id: d.id, text: d.text, updatedAt: d.updatedAt, images: d.images.length })),
  };
  try {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* quota or blocked storage: the in-memory drafts still work */
  }
  const keys = dirtyImages;
  dirtyImages = new Set();
  for (const key of keys) {
    const [kind, id = ""] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const images = kind === "thread" ? drafts[id]?.images : stash.find((d) => d.id === id)?.images;
    void idbPut(key, images ?? []);
  }
}

function schedule(imageKey?: string): void {
  if (imageKey) dirtyImages.add(imageKey);
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(flushDrafts, DEBOUNCE_MS);
}

export const useDrafts = create<DraftsState>(() => ({ drafts: {}, stash: [] }));

/** Loads persisted text synchronously and images asynchronously; call once at boot. */
export function hydrateDrafts(): Promise<void> {
  const stored = readStored();
  if (!stored) return Promise.resolve();
  const drafts: Record<string, Draft> = {};
  for (const [id, d] of Object.entries(stored.drafts ?? {})) {
    drafts[id] = { text: d.text ?? "", images: [], updatedAt: d.updatedAt ?? 0 };
  }
  const stash: StashedDraft[] = (stored.stash ?? []).map((d) => ({ id: d.id, text: d.text ?? "", images: [], updatedAt: d.updatedAt ?? 0 }));
  useDrafts.setState((s) => ({ drafts: { ...drafts, ...s.drafts }, stash: s.stash.length > 0 ? s.stash : stash }));
  const jobs: Promise<void>[] = [];
  for (const [id, d] of Object.entries(stored.drafts ?? {})) {
    if (!d.images) continue;
    jobs.push(
      idbGet(threadKey(id)).then((images) => {
        if (!images?.length) return;
        useDrafts.setState((s) => {
          const cur = s.drafts[id];
          return cur && cur.images.length === 0 ? { drafts: { ...s.drafts, [id]: { ...cur, images } } } : s;
        });
      }),
    );
  }
  for (const d of stored.stash ?? []) {
    if (!d.images) continue;
    jobs.push(
      idbGet(stashKey(d.id)).then((images) => {
        if (!images?.length) return;
        useDrafts.setState((s) => ({ stash: s.stash.map((x) => (x.id === d.id && x.images.length === 0 ? { ...x, images } : x)) }));
      }),
    );
  }
  return Promise.all(jobs).then(() => undefined);
}

export function getDraft(threadId: string): Draft | undefined {
  return useDrafts.getState().drafts[threadId];
}

export function setDraft(threadId: string, patch: Partial<Pick<Draft, "text" | "images">>): void {
  const prev = useDrafts.getState().drafts[threadId];
  const next: Draft = {
    text: patch.text ?? prev?.text ?? "",
    images: patch.images ?? prev?.images ?? [],
    updatedAt: Date.now(),
  };
  if (empty(next)) {
    if (prev) clearDraft(threadId);
    return;
  }
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [threadId]: next } }));
  schedule(patch.images ? threadKey(threadId) : undefined);
}

export function clearDraft(threadId: string): void {
  if (!useDrafts.getState().drafts[threadId]) return;
  useDrafts.setState((s) => {
    const { [threadId]: _gone, ...rest } = s.drafts;
    return { drafts: rest };
  });
  schedule(threadKey(threadId));
}

/** Moves the thread's draft onto the stash and clears it. Returns the stash id. */
export function stashDraft(threadId: string): string | undefined {
  const draft = getDraft(threadId);
  if (!draft || empty(draft)) return undefined;
  const id = newId();
  useDrafts.setState((s) => ({ stash: [...s.stash, { ...draft, id }] }));
  schedule(stashKey(id));
  clearDraft(threadId);
  return id;
}

/** Merges a stash entry (latest by default) into the thread's draft and drops it from the stash. */
export function applyStash(threadId: string, stashId?: string): boolean {
  const { stash } = useDrafts.getState();
  const entry = stashId ? stash.find((d) => d.id === stashId) : stash[stash.length - 1];
  if (!entry) return false;
  const cur = getDraft(threadId);
  const text = [cur?.text.trimEnd(), entry.text].filter((t) => t && t.trim() !== "").join("\n\n");
  setDraft(threadId, { text, images: [...(cur?.images ?? []), ...entry.images].slice(0, 8) });
  removeStash(entry.id);
  return true;
}

export function removeStash(id: string): void {
  if (!useDrafts.getState().stash.some((d) => d.id === id)) return;
  useDrafts.setState((s) => ({ stash: s.stash.filter((d) => d.id !== id) }));
  schedule(stashKey(id));
}

/** Number of non-empty drafts (threads) and stash entries, for rail/badge use. */
export function useDraftCount(): number {
  return useDrafts((s) => Object.keys(s.drafts).length + s.stash.length);
}

/** Draft hook for any other prompt box (e.g. the New-thread popover): key it with `new:<projectId>`. */
export function useDraftText(key: string): [string, (text: string) => void, () => void] {
  const text = useDrafts((s) => s.drafts[key]?.text ?? "");
  return [text, (value) => setDraft(key, { text: value }), () => clearDraft(key)];
}

/** Test seam. */
export function resetDrafts(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  dirtyImages = new Set();
  useDrafts.setState({ drafts: {}, stash: [] });
}

if (typeof window !== "undefined") void hydrateDrafts();
