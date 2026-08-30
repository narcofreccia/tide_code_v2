import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FsChange } from "@tide/contracts";
import { IgnoreCache, isGitInternal, type GitFactory } from "./ignore.ts";

export type WatchStrategy = "native" | "poll";

export interface FsWatcherOptions {
  /** coalescing window; every change seen inside it is emitted as one batch */
  debounceMs?: number;
  /** default: `fs.watch` recursive everywhere except Linux, which has no recursive mode */
  strategy?: WatchStrategy;
  pollIntervalMs?: number;
  /** polling stops descending past this many files, to bound the walk */
  maxFiles?: number;
  git?: GitFactory;
  log?: (msg: string, data?: unknown) => void;
  now?: () => number;
}

type Listener = (change: FsChange) => void;

interface PollEntry {
  mtime: number;
  size: number;
}

const DEBOUNCE_MS = 100;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_FILES = 20_000;

/**
 * Recursive change stream per cwd.
 *
 * Strategy: `fs.watch(dir, { recursive: true })` on macOS and Windows, where node 22
 * implements it natively. Linux has no recursive inotify, so we fall back to a stat walk
 * every 2s over the non-ignored tree, capped at 20k files — a directory larger than that
 * simply stops being watched past the cap rather than exhausting memory.
 *
 * Changes are debounced 100ms and coalesced per path; `.git/**` and gitignored paths are
 * dropped. The ignore lookup is cached per cwd and invalidated when a `.gitignore` changes.
 */
export class FsWatcher {
  #debounceMs: number;
  #strategy: WatchStrategy;
  #pollIntervalMs: number;
  #maxFiles: number;
  #git: GitFactory | undefined;
  #log: (msg: string, data?: unknown) => void;
  #now: () => number;
  #watches = new Map<string, Watch>();

  constructor(options: FsWatcherOptions = {}) {
    this.#debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.#strategy = options.strategy ?? (process.platform === "linux" ? "poll" : "native");
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#maxFiles = options.maxFiles ?? MAX_POLL_FILES;
    this.#git = options.git;
    this.#log = options.log ?? (() => undefined);
    this.#now = options.now ?? (() => Date.now());
  }

  /** Reference-counted: subscribers on one cwd share a single underlying watch. */
  subscribe(cwd: string, listener: Listener): () => void {
    let watchState = this.#watches.get(cwd);
    if (watchState === undefined) {
      watchState = new Watch(cwd, {
        debounceMs: this.#debounceMs,
        strategy: this.#strategy,
        pollIntervalMs: this.#pollIntervalMs,
        maxFiles: this.#maxFiles,
        log: this.#log,
        now: this.#now,
        ...(this.#git !== undefined ? { git: this.#git } : {}),
      });
      this.#watches.set(cwd, watchState);
      watchState.start();
    }
    const state = watchState;
    state.listeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.listeners.delete(listener);
      if (state.listeners.size === 0) {
        state.close();
        this.#watches.delete(cwd);
      }
    };
  }

  get size(): number {
    return this.#watches.size;
  }

  closeAll(): void {
    for (const state of this.#watches.values()) state.close();
    this.#watches.clear();
  }
}

interface WatchOptions {
  debounceMs: number;
  strategy: WatchStrategy;
  pollIntervalMs: number;
  maxFiles: number;
  git?: GitFactory;
  log: (msg: string, data?: unknown) => void;
  now: () => number;
}

/** One underlying watcher for one cwd, shared by every subscriber on it. */
class Watch {
  readonly listeners = new Set<Listener>();
  #cwd: string;
  #options: WatchOptions;
  #ignores: IgnoreCache;
  #pending = new Map<string, FsChange["kind"]>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #native: FSWatcher | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #snapshot = new Map<string, PollEntry>();
  #polling = false;
  #closed = false;

  constructor(cwd: string, options: WatchOptions) {
    this.#cwd = cwd;
    this.#options = options;
    this.#ignores = new IgnoreCache(cwd, options.git);
  }

  start(): void {
    if (this.#options.strategy === "native" && this.#startNative()) return;
    this.#startPolling();
  }

  #startNative(): boolean {
    try {
      this.#native = watch(this.#cwd, { recursive: true, persistent: false }, (eventType, filename) => {
        if (filename === null) return;
        const rel = typeof filename === "string" ? filename : String(filename);
        void this.#record(rel, eventType === "change" ? "modified" : undefined);
      });
      this.#native.on("error", (err) => {
        this.#options.log("[fs.watch] native watcher failed, falling back to polling", err);
        this.#native?.close();
        this.#native = undefined;
        if (!this.#closed) this.#startPolling();
      });
      return true;
    } catch (err) {
      this.#options.log("[fs.watch] recursive watch unavailable, falling back to polling", err);
      return false;
    }
  }

  #startPolling(): void {
    void this.#scan(true);
    this.#poll = setInterval(() => void this.#scan(false), this.#options.pollIntervalMs);
    this.#poll.unref?.();
  }

  /** `known` = seed the baseline without emitting. */
  async #scan(seed: boolean): Promise<void> {
    if (this.#polling || this.#closed) return;
    this.#polling = true;
    try {
      const seen = new Map<string, PollEntry>();
      await this.#walk(this.#cwd, "", seen);
      if (!seed) {
        for (const [path, entry] of seen) {
          const previous = this.#snapshot.get(path);
          if (previous === undefined) await this.#record(path, "created");
          else if (previous.mtime !== entry.mtime || previous.size !== entry.size) await this.#record(path, "modified");
        }
        for (const path of this.#snapshot.keys()) if (!seen.has(path)) await this.#record(path, "deleted");
      }
      this.#snapshot = seen;
    } catch (err) {
      this.#options.log("[fs.watch] poll scan failed", err);
    } finally {
      this.#polling = false;
    }
  }

  async #walk(dir: string, rel: string, out: Map<string, PollEntry>): Promise<void> {
    if (out.size >= this.#options.maxFiles) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const children = dirents.filter((d) => d.name !== ".git").map((d) => ({ d, rel: rel === "" ? d.name : `${rel}/${d.name}` }));
    const ignored = await this.#ignores.resolve(children.map((c) => c.rel));
    for (const child of children) {
      if (ignored.get(child.rel) === true) continue;
      if (out.size >= this.#options.maxFiles) return;
      const full = join(dir, child.d.name);
      if (child.d.isDirectory()) {
        await this.#walk(full, child.rel, out);
        continue;
      }
      const st = await stat(full).catch(() => undefined);
      if (st === undefined) continue;
      out.set(child.rel, { mtime: Math.floor(st.mtimeMs), size: st.size });
    }
  }

  /** Queues one path; `kind` is inferred from existence when the event does not say. */
  async #record(rawRel: string, kind: FsChange["kind"] | undefined): Promise<void> {
    if (this.#closed) return;
    const rel = rawRel.split("\\").join("/");
    if (rel === "" || isGitInternal(rel)) return;
    if (rel.endsWith(".tide-tmp")) return;
    if (IgnoreCache.affectsIgnores(rel)) this.#ignores.invalidate();
    let resolved = kind;
    if (resolved === undefined) {
      const exists = await stat(join(this.#cwd, rel)).then(
        () => true,
        () => false,
      );
      resolved = exists ? "created" : "deleted";
    }
    const previous = this.#pending.get(rel);
    // deletion is terminal for the window; otherwise the first kind seen wins
    this.#pending.set(rel, resolved === "deleted" || previous === undefined ? resolved : previous);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => void this.#flush(), this.#options.debounceMs);
    this.#timer.unref?.();
  }

  async #flush(): Promise<void> {
    this.#timer = undefined;
    if (this.#closed) return;
    const batch = [...this.#pending];
    this.#pending.clear();
    if (batch.length === 0) return;
    const ignored = await this.#ignores.resolve(batch.map(([path]) => path));
    if (this.#closed) return;
    const at = this.#options.now();
    for (const [path, kind] of batch) {
      if (ignored.get(path) === true) continue;
      for (const listener of this.listeners) listener({ path, kind, at });
    }
  }

  close(): void {
    this.#closed = true;
    this.listeners.clear();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#native?.close();
    this.#native = undefined;
    if (this.#poll !== undefined) clearInterval(this.#poll);
    this.#poll = undefined;
  }
}
