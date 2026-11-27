import { isResidentActivity, type Activity, type ReadModel, type Turn } from "@tide/contracts";
import { selectThreadTurns } from "./selectors.ts";

/*
 * R24: per-thread activity windows on a `scope: "resident"` store. The store holds every
 * thread's resident activities; a thread someone looks at also holds the activities of a
 * contiguous window of its newest turns, fetched with `thread.activities`. Turns that start
 * later are inside the window by construction (their activities stream in live). Threads
 * that fall out of a small LRU lose their non-resident activities again, so the map — and
 * the copy every `activity.upserted` makes of it — stays small.
 */

/** Turns in the first window of a thread. */
export const INITIAL_TURNS = 15;
/** Turns each "Show earlier" adds. */
export const EARLIER_TURNS = 15;
/** Threads (besides the ones on screen) whose fetched activities are kept. */
export const KEEP_THREADS = 4;

/** What the tracker needs from the store(s) it fills; one store, or a router over several. */
export interface ThreadActivitiesHost {
  /** the model the windows are read against (turn order, timeline, held activities) */
  getModel(): ReadModel;
  /**
   * The snapshot epoch of the store that owns the thread (`ModelStoreState.epoch`); a change
   * means its fetched activities are gone. `undefined`: that store holds the full model,
   * nothing to fetch and every turn is in the window.
   */
  epoch(threadId: string): number | undefined;
  /** `thread.activities` */
  fetch(threadId: string, turnIds: readonly string[]): Promise<readonly Activity[]>;
  /** into the owning store (`ModelStore.mergeActivities`) */
  merge(threadId: string, activities: readonly Activity[]): void;
  /** from every store that holds them (`ModelStore.dropActivities`) */
  drop(ids: ReadonlySet<string>): void;
  /** model changes: snapshots (epoch moves) and threads appearing */
  subscribe(listener: () => void): () => void;
}

export interface ThreadWindow {
  /**
   * First turn of the window. `undefined`: not resolved yet, the newest {@link INITIAL_TURNS}
   * turns; `null`: every turn (start of the thread reached, or a full store).
   */
  readonly anchor: string | null | undefined;
  /** the first window is in flight */
  readonly loading: boolean;
  /** a "Show earlier" fetch is in flight */
  readonly loadingEarlier: boolean;
  /** the last fetch failed; `retry` repeats it */
  readonly error: string | undefined;
  /** which fetch `error` is about */
  readonly errorOn: "window" | "earlier" | undefined;
}

interface Entry {
  window: ThreadWindow;
  /** the owner's epoch the window was loaded under */
  epoch: number | undefined;
  /** the initial window landed (or there was nothing to fetch) */
  loaded: boolean;
  /** bumps on reset: replies of an older generation are dropped */
  gen: number;
}

const UNLOADED: ThreadWindow = { anchor: undefined, loading: false, loadingEarlier: false, error: undefined, errorOn: undefined };
const ALL: ThreadWindow = { anchor: null, loading: false, loadingEarlier: false, error: undefined, errorOn: undefined };

/** Index of the window's first turn in `turns` (the thread's turn order). */
export function windowStartIndex(window: ThreadWindow, turns: readonly Turn[]): number {
  if (window.anchor === null) return 0;
  if (window.anchor !== undefined) {
    const i = turns.findIndex((t) => t.id === window.anchor);
    if (i >= 0) return i;
  }
  return Math.max(0, turns.length - INITIAL_TURNS);
}

export interface ThreadActivities {
  /**
   * A surface shows this thread: keeps it out of pruning until released, marks it most
   * recently used, prunes the threads that fell out, and ensures its window.
   */
  open(threadId: string): () => void;
  /** Fetch the first window if it is not held (no-op while in flight or loaded). */
  ensureWindow(threadId: string): void;
  /** Extend the window by {@link EARLIER_TURNS} older turns. */
  loadEarlier(threadId: string): void;
  /** After an error: retries whichever fetch failed (the first window, or the earlier turns). */
  retry(threadId: string): void;
  /** Stable per change; {@link windowStartIndex} turns it into a turn index. */
  windowOf(threadId: string): ThreadWindow;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A server from before R24 does not know `thread.activities`, and sent the full model anyway. */
function isMethodNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "method-not-found";
}

export function createThreadActivities(host: ThreadActivitiesHost, opts: { keep?: number } = {}): ThreadActivities {
  const keep = opts.keep ?? KEEP_THREADS;
  const entries = new Map<string, Entry>();
  const retained = new Map<string, number>();
  /** most recently opened first */
  let recent: string[] = [];
  const listeners = new Set<() => void>();
  let genCounter = 0;

  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  const setWindow = (entry: Entry, patch: Partial<ThreadWindow>): void => {
    entry.window = { ...entry.window, ...patch };
    emit();
  };
  const entryOf = (threadId: string): Entry => {
    let entry = entries.get(threadId);
    if (entry === undefined) {
      entry = { window: UNLOADED, epoch: host.epoch(threadId), loaded: false, gen: ++genCounter };
      entries.set(threadId, entry);
    }
    return entry;
  };

  /** Fetch `turnIds` for the entry's current generation; `onDone` runs only if still current. */
  const request = (threadId: string, entry: Entry, turnIds: readonly string[], onDone: () => void, onFail: (err: unknown) => void): void => {
    const gen = entry.gen;
    const epoch = entry.epoch;
    const current = (): boolean => entries.get(threadId) === entry && entry.gen === gen && host.epoch(threadId) === epoch;
    host.fetch(threadId, turnIds).then(
      (activities) => {
        if (!current()) return;
        // a thread deleted while the reply was in flight: nothing to fill
        if (host.getModel().threads[threadId] !== undefined) host.merge(threadId, activities);
        onDone();
      },
      (err: unknown) => {
        if (current()) onFail(err);
      },
    );
  };

  /** Turns of running sub-agents outside the window: their tool rows feed the background-agents panel. */
  const childTurns = (model: ReadModel, threadId: string, inWindow: ReadonlySet<string>): string[] => {
    const out = new Set<string>();
    for (const a of Object.values(model.activities)) {
      if (a.threadId === threadId && a.kind === "child" && a.status === "running" && !inWindow.has(a.turnId)) out.add(a.turnId);
    }
    return [...out];
  };

  const ensureWindow = (threadId: string): void => {
    const entry = entryOf(threadId);
    if (entry.loaded || entry.window.loading) return;
    const epoch = host.epoch(threadId);
    entry.epoch = epoch;
    if (epoch === undefined) {
      entry.loaded = true;
      entry.window = ALL;
      emit();
      return;
    }
    const model = host.getModel();
    // not in the model yet (before the first snapshot): the next model change retries
    if (model.threads[threadId] === undefined) return;
    const turns = selectThreadTurns(model, threadId);
    const start = Math.max(0, turns.length - INITIAL_TURNS);
    const ids = turns.slice(start).map((t) => t.id);
    const anchor = start === 0 ? null : (turns[start]?.id ?? null);
    if (ids.length === 0) {
      entry.loaded = true;
      setWindow(entry, { anchor: null, loading: false, error: undefined, errorOn: undefined });
      return;
    }
    const extra = childTurns(model, threadId, new Set(ids));
    setWindow(entry, { anchor, loading: true, error: undefined, errorOn: undefined });
    request(
      threadId,
      entry,
      [...ids, ...extra],
      () => {
        entry.loaded = true;
        setWindow(entry, { loading: false });
      },
      (err) => {
        if (isMethodNotFound(err)) {
          entry.loaded = true;
          setWindow(entry, { anchor: null, loading: false });
        } else setWindow(entry, { loading: false, error: errorText(err), errorOn: "window" });
      },
    );
  };

  const loadEarlier = (threadId: string): void => {
    const entry = entries.get(threadId);
    if (entry === undefined || !entry.loaded || entry.window.loadingEarlier) return;
    const turns = selectThreadTurns(host.getModel(), threadId);
    const end = windowStartIndex(entry.window, turns);
    if (end === 0) return;
    const start = Math.max(0, end - EARLIER_TURNS);
    const anchor = start === 0 ? null : (turns[start]?.id ?? null);
    setWindow(entry, { loadingEarlier: true, error: undefined, errorOn: undefined });
    // the window grows when the activities are here, so rows appear once (one scroll anchor)
    request(
      threadId,
      entry,
      turns.slice(start, end).map((t) => t.id),
      () => setWindow(entry, { anchor, loadingEarlier: false }),
      (err) => setWindow(entry, { loadingEarlier: false, error: errorText(err), errorOn: "earlier" }),
    );
  };

  /** Drop every non-resident activity of threads neither on screen nor recently opened. */
  const prune = (): void => {
    const kept = new Set([...recent.slice(0, keep), ...retained.keys()]);
    recent = recent.filter((id) => kept.has(id));
    for (const id of [...entries.keys()]) if (!kept.has(id)) entries.delete(id);
    const model = host.getModel();
    const all = Object.values(model.activities);
    // tool rows under a running sub-agent count toward its background-agent stats: keep them
    const runningChildren = new Set<string>();
    for (const a of all) if (a.kind === "child" && a.status === "running") runningChildren.add(`${a.threadId}\u0000${a.childKey}`);
    const drop = new Set<string>();
    for (const a of all) {
      if (kept.has(a.threadId) || isResidentActivity(model, a)) continue;
      if (a.kind === "tool" && a.parentToolUseId !== undefined && runningChildren.has(`${a.threadId}\u0000${a.parentToolUseId}`)) continue;
      drop.add(a.id);
    }
    if (drop.size > 0) host.drop(drop);
  };

  /** A snapshot replaced a store's model (epoch moved) or a thread appeared: reset and re-ensure. */
  const onModel = (): void => {
    let changed = false;
    for (const [threadId, entry] of [...entries]) {
      if (host.epoch(threadId) !== entry.epoch) {
        entries.delete(threadId);
        changed = true;
      }
    }
    if (changed) emit();
    for (const threadId of retained.keys()) {
      const entry = entries.get(threadId);
      if (entry === undefined || (!entry.loaded && !entry.window.loading && entry.window.error === undefined)) ensureWindow(threadId);
    }
  };
  const offHost = host.subscribe(onModel);

  return {
    open(threadId) {
      retained.set(threadId, (retained.get(threadId) ?? 0) + 1);
      recent = [threadId, ...recent.filter((id) => id !== threadId)];
      prune();
      ensureWindow(threadId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (retained.get(threadId) ?? 1) - 1;
        if (n <= 0) retained.delete(threadId);
        else retained.set(threadId, n);
      };
    },
    ensureWindow,
    loadEarlier,
    retry(threadId) {
      if (entries.get(threadId)?.loaded === true) loadEarlier(threadId);
      else ensureWindow(threadId);
    },
    windowOf(threadId) {
      const entry = entries.get(threadId);
      if (entry !== undefined) return entry.window;
      return host.epoch(threadId) === undefined ? ALL : UNLOADED;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      offHost();
      listeners.clear();
      entries.clear();
      retained.clear();
      recent = [];
    },
  };
}
