import { basename } from "node:path";
import { newId, type PtyChunk } from "@tide/contracts";
import { RpcException } from "../../rpc/router.ts";
import { createBunBackend, isBunRuntime } from "./bunBackend.ts";
import { createNodePtyBackend } from "./nodePtyBackend.ts";
import type { PtyBackend, PtyExit, PtyHandle, PtyInfo } from "./types.ts";

/** Per-terminal replay buffer handed to every new attach. */
export const SCROLLBACK_BYTES = 512 * 1024;
/** A dead terminal stays listable this long so the UI can show its exit. */
export const REAP_AFTER_MS = 5 * 60_000;

/** OSC 0 / OSC 2 window-title sequence, terminated by BEL or ST. */
const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface PtyManagerOptions {
  /** injected in tests; production picks Bun's terminal under Bun, else node-pty */
  backend?: PtyBackend | (() => Promise<PtyBackend>);
  scrollbackBytes?: number;
  reapAfterMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

interface Entry {
  id: string;
  threadId: string;
  handle: PtyHandle;
  scrollback: string[];
  scrollbackBytes: number;
  listeners: Set<(chunk: PtyChunk) => void>;
  title: string | undefined;
  fallbackTitle: string;
  alive: boolean;
  exit: PtyExit | undefined;
  reaper: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Picks the pty implementation for this runtime. Under Bun (the compiled desktop sidecar)
 * the native node-pty module is not embeddable, so `Bun.spawn({ terminal })` is used
 * instead; everything above this line is identical for both.
 */
export function selectPtyBackend(): Promise<PtyBackend> {
  if (isBunRuntime()) return Promise.resolve(createBunBackend());
  return createNodePtyBackend();
}

const defaultShell = (): string => {
  if (process.platform === "win32") return "powershell.exe";
  const fromEnv = process.env["SHELL"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : "/bin/zsh";
};

/** Owns every terminal in the server process; one instance per app. */
export class PtyManager {
  #backend: () => Promise<PtyBackend>;
  #scrollbackBytes: number;
  #reapAfterMs: number;
  #log: (msg: string, data?: unknown) => void;
  #ptys = new Map<string, Entry>();
  #announced = false;

  constructor(options: PtyManagerOptions = {}) {
    const backend = options.backend;
    this.#backend =
      backend === undefined ? selectPtyBackend : typeof backend === "function" ? backend : () => Promise.resolve(backend);
    this.#scrollbackBytes = options.scrollbackBytes ?? SCROLLBACK_BYTES;
    this.#reapAfterMs = options.reapAfterMs ?? REAP_AFTER_MS;
    this.#log = options.log ?? (() => undefined);
  }

  async create(threadId: string, cwd: string, cols: number, rows: number, shell?: string): Promise<string> {
    let backend: PtyBackend;
    try {
      backend = await this.#backend();
    } catch (err) {
      this.#log("[pty] no terminal backend available", err);
      throw new RpcException("unavailable", "terminal support not built");
    }
    if (!this.#announced) {
      this.#announced = true;
      this.#log(`[pty] backend: ${backend.name}`);
    }
    const file = shell !== undefined && shell !== "" ? shell : defaultShell();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env["TERM"] = "xterm-256color";
    env["COLORTERM"] = "truecolor";
    env["TIDE_THREAD_ID"] = threadId;

    const id = newId();
    let handle: PtyHandle;
    try {
      handle = backend.spawn({
        file,
        cwd,
        cols: Math.max(1, Math.floor(cols)),
        rows: Math.max(1, Math.floor(rows)),
        env,
      });
    } catch (err) {
      this.#log(`[pty] ${backend.name} spawn failed`, err);
      throw new RpcException("unavailable", "terminal support not built");
    }

    const entry: Entry = {
      id,
      threadId,
      handle,
      scrollback: [],
      scrollbackBytes: 0,
      listeners: new Set(),
      title: undefined,
      fallbackTitle: basename(file),
      alive: true,
      exit: undefined,
      reaper: undefined,
    };
    this.#ptys.set(id, entry);

    handle.onData((data) => {
      this.#readTitle(entry, data);
      this.#append(entry, data);
      for (const listener of [...entry.listeners]) listener({ kind: "data", data });
    });
    handle.onExit((exit) => {
      if (!entry.alive) return;
      entry.alive = false;
      entry.exit = exit;
      const chunk: PtyChunk = { kind: "exit", ...exit };
      for (const listener of [...entry.listeners]) listener(chunk);
      entry.listeners.clear();
      entry.reaper = setTimeout(() => this.#ptys.delete(id), this.#reapAfterMs);
      entry.reaper.unref?.();
    });
    return id;
  }

  /** Replays the scrollback as one chunk, then streams. Returns the detach function. */
  attach(ptyId: string, emit: (chunk: PtyChunk) => void): () => void {
    const entry = this.#require(ptyId);
    const replay = entry.scrollback.join("");
    if (replay !== "") emit({ kind: "data", data: replay });
    if (!entry.alive) {
      emit({ kind: "exit", ...(entry.exit ?? {}) });
      return () => undefined;
    }
    entry.listeners.add(emit);
    return () => {
      entry.listeners.delete(emit);
    };
  }

  write(ptyId: string, data: string): void {
    const entry = this.#require(ptyId);
    if (!entry.alive) throw new RpcException("conflict", `terminal ${ptyId} has exited`);
    entry.handle.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.#require(ptyId);
    if (!entry.alive) return;
    entry.handle.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  kill(ptyId: string): void {
    const entry = this.#require(ptyId);
    if (!entry.alive) return;
    try {
      entry.handle.kill();
    } catch (err) {
      this.#log("[pty] kill failed", err);
    }
  }

  list(threadId: string): PtyInfo[] {
    const out: PtyInfo[] = [];
    for (const entry of this.#ptys.values()) {
      if (entry.threadId !== threadId) continue;
      out.push({ ptyId: entry.id, title: entry.title ?? entry.fallbackTitle, alive: entry.alive });
    }
    return out;
  }

  /** Kills every terminal; called when the server closes. */
  closeAll(): void {
    for (const entry of this.#ptys.values()) {
      if (entry.reaper !== undefined) clearTimeout(entry.reaper);
      entry.listeners.clear();
      if (!entry.alive) continue;
      try {
        entry.handle.kill();
      } catch {
        // already gone
      }
    }
    this.#ptys.clear();
  }

  #require(ptyId: string): Entry {
    const entry = this.#ptys.get(ptyId);
    if (entry === undefined) throw new RpcException("not-found", `unknown terminal ${ptyId}`);
    return entry;
  }

  #append(entry: Entry, data: string): void {
    entry.scrollback.push(data);
    entry.scrollbackBytes += Buffer.byteLength(data, "utf8");
    while (entry.scrollbackBytes > this.#scrollbackBytes && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift();
      entry.scrollbackBytes -= Buffer.byteLength(dropped ?? "", "utf8");
    }
  }

  #readTitle(entry: Entry, data: string): void {
    OSC_TITLE.lastIndex = 0;
    let last: string | undefined;
    for (;;) {
      const hit = OSC_TITLE.exec(data);
      if (hit === null) break;
      last = hit[1];
    }
    if (last !== undefined) entry.title = last;
  }
}
