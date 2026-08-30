import { accessSync, chmodSync, constants as FS } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { newId, type PtyChunk } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";

/** Per-terminal replay buffer handed to every new attach. */
export const SCROLLBACK_BYTES = 512 * 1024;
/** A dead terminal stays listable this long so the UI can show its exit. */
export const REAP_AFTER_MS = 5 * 60_000;

// Minimal structural view of node-pty; the real types live behind an optional native module.
interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
  ): PtyProcess;
}

export interface PtyInfo {
  ptyId: string;
  title?: string;
  alive: boolean;
}

export interface PtyManagerOptions {
  /** injected in tests; production loads `node-pty` lazily */
  load?: () => Promise<PtyModule>;
  scrollbackBytes?: number;
  reapAfterMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

interface Entry {
  id: string;
  threadId: string;
  proc: PtyProcess;
  scrollback: string[];
  scrollbackBytes: number;
  listeners: Set<(chunk: PtyChunk) => void>;
  title: string | undefined;
  fallbackTitle: string;
  alive: boolean;
  exit: { code?: number; signal?: string } | undefined;
  reaper: ReturnType<typeof setTimeout> | undefined;
}

/** OSC 0 / OSC 2 window-title sequence, terminated by BEL or ST. */
const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

let cached: Promise<PtyModule> | undefined;

/**
 * node-pty is the one native dependency in the server process. A missing or mismatched
 * prebuild must degrade to an `unavailable` error rather than kill the process at boot,
 * so the import happens on first use and is cached.
 */
export function loadNodePty(): Promise<PtyModule> {
  cached ??= (async () => {
    const mod = (await import("node-pty")) as unknown as { default?: PtyModule; spawn?: PtyModule["spawn"] };
    const resolved = typeof mod.spawn === "function" ? (mod as unknown as PtyModule) : mod.default;
    if (resolved === undefined || typeof resolved.spawn !== "function") throw new Error("node-pty has no spawn()");
    ensureSpawnHelperExecutable();
    return resolved;
  })().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

/**
 * Some package managers drop the exec bit when extracting node-pty's prebuilt
 * `spawn-helper`, which makes every fork fail with "posix_spawnp failed". Restore it.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("node-pty/package.json");
    const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    try {
      accessSync(helper, FS.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  } catch {
    // built from source (build/Release) or genuinely missing: spawn will report it
  }
}

const defaultShell = (): string => {
  if (process.platform === "win32") return "powershell.exe";
  const fromEnv = process.env["SHELL"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : "/bin/zsh";
};

/** Owns every terminal in the server process; one instance per app. */
export class PtyManager {
  #load: () => Promise<PtyModule>;
  #scrollbackBytes: number;
  #reapAfterMs: number;
  #log: (msg: string, data?: unknown) => void;
  #ptys = new Map<string, Entry>();

  constructor(options: PtyManagerOptions = {}) {
    this.#load = options.load ?? loadNodePty;
    this.#scrollbackBytes = options.scrollbackBytes ?? SCROLLBACK_BYTES;
    this.#reapAfterMs = options.reapAfterMs ?? REAP_AFTER_MS;
    this.#log = options.log ?? (() => undefined);
  }

  async create(threadId: string, cwd: string, cols: number, rows: number, shell?: string): Promise<string> {
    let mod: PtyModule;
    try {
      mod = await this.#load();
    } catch (err) {
      this.#log("[pty] node-pty unavailable", err);
      throw new RpcException("unavailable", "terminal support not built");
    }
    const file = shell !== undefined && shell !== "" ? shell : defaultShell();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env["TERM"] = "xterm-256color";
    env["COLORTERM"] = "truecolor";
    env["TIDE_THREAD_ID"] = threadId;

    const id = newId();
    let proc: PtyProcess;
    try {
      proc = mod.spawn(file, [], {
        name: "xterm-256color",
        cwd,
        cols: Math.max(1, Math.floor(cols)),
        rows: Math.max(1, Math.floor(rows)),
        env,
      });
    } catch (err) {
      this.#log("[pty] spawn failed", err);
      throw new RpcException("unavailable", "terminal support not built");
    }

    const entry: Entry = {
      id,
      threadId,
      proc,
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

    proc.onData((data) => {
      this.#readTitle(entry, data);
      this.#append(entry, data);
      for (const listener of [...entry.listeners]) listener({ kind: "data", data });
    });
    proc.onExit(({ exitCode, signal }) => {
      entry.alive = false;
      entry.exit = {
        ...(typeof exitCode === "number" ? { code: exitCode } : {}),
        ...(signal !== undefined && signal !== 0 ? { signal: String(signal) } : {}),
      };
      const chunk: PtyChunk = { kind: "exit", ...entry.exit };
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
    entry.proc.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.#require(ptyId);
    if (!entry.alive) return;
    entry.proc.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  kill(ptyId: string): void {
    const entry = this.#require(ptyId);
    if (!entry.alive) return;
    try {
      entry.proc.kill();
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
        entry.proc.kill();
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
