import { basename } from "node:path";
import { newId, type PtyChunk } from "@tide/contracts";
import { RpcException } from "../../rpc/router.ts";
import { createBunBackend, isBunRuntime } from "./bunBackend.ts";
import { createNodePtyBackend } from "./nodePtyBackend.ts";
import { childPids, type TreeSignal } from "./killTree.ts";
import type { PtyBackend, PtyExit, PtyHandle, PtyInfo } from "./types.ts";

/** Per-terminal replay buffer handed to every new attach. */
export const SCROLLBACK_BYTES = 512 * 1024;
/** A dead terminal stays listable this long so the UI can show its exit. */
export const REAP_AFTER_MS = 5 * 60_000;
/** A spec's `command` is typed once the shell printed something, or after this long. */
export const COMMAND_DELAY_MS = 300;
/** Per-step wait of the SIGINT → SIGTERM → SIGKILL escalation. */
export const STOP_GRACE_MS = 3000;
export const MAX_COMMAND_LENGTH = 4096;
export const STOP_POLL_MS = 250;

/** OSC 0 / OSC 2 window-title sequence, terminated by BEL or ST. */
const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface PtyManagerOptions {
  /** injected in tests; production picks Bun's terminal under Bun, else node-pty */
  backend?: PtyBackend | (() => Promise<PtyBackend>);
  scrollbackBytes?: number;
  reapAfterMs?: number;
  log?: (msg: string, data?: unknown) => void;
  /** one-shot timer; returns its canceller (tests drive the command delay) */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** the stop escalation's wait */
  sleep?: (ms: number) => Promise<void>;
  commandDelayMs?: number;
  /** how often `stop` checks whether the shell's children are gone */
  stopPollMs?: number;
  /** a shell's live child pids (default: a `ps` walk) */
  children?: (pid: number) => Promise<number[]>;
}

/** A terminal to open. `ownerId` is a thread id, or `run:<projectId>` for run-stack services. */
export interface PtyCreateSpec {
  ownerId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  /** merged last: the caller wins over `process.env` and the TERM/TIDE_* defaults */
  env?: Record<string, string>;
  /** typed into the shell (leading space: zsh HIST_IGNORE_SPACE keeps it out of history) */
  command?: string;
  /** shown in `pty.list` (the run-stack service name) */
  label?: string;
}

interface Entry {
  id: string;
  ownerId: string;
  label: string | undefined;
  handle: PtyHandle;
  exited: Promise<void>;
  scrollback: string[];
  scrollbackBytes: number;
  listeners: Set<(chunk: PtyChunk) => void>;
  title: string | undefined;
  fallbackTitle: string;
  alive: boolean;
  exit: PtyExit | undefined;
  reaper: ReturnType<typeof setTimeout> | undefined;
}

const realSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

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
  #schedule: (fn: () => void, ms: number) => () => void;
  #sleep: (ms: number) => Promise<void>;
  #commandDelayMs: number;
  #stopPollMs: number;
  #children: (pid: number) => Promise<number[]>;
  #ptys = new Map<string, Entry>();
  #announced = false;

  constructor(options: PtyManagerOptions = {}) {
    const backend = options.backend;
    this.#backend =
      backend === undefined ? selectPtyBackend : typeof backend === "function" ? backend : () => Promise.resolve(backend);
    this.#scrollbackBytes = options.scrollbackBytes ?? SCROLLBACK_BYTES;
    this.#reapAfterMs = options.reapAfterMs ?? REAP_AFTER_MS;
    this.#log = options.log ?? (() => undefined);
    this.#schedule = options.schedule ?? realSchedule;
    this.#sleep = options.sleep ?? realSleep;
    this.#commandDelayMs = options.commandDelayMs ?? COMMAND_DELAY_MS;
    this.#stopPollMs = Math.max(1, options.stopPollMs ?? STOP_POLL_MS);
    this.#children = options.children ?? childPids;
  }

  create(spec: PtyCreateSpec): Promise<string>;
  /** thread terminals, positional form kept for existing callers */
  create(threadId: string, cwd: string, cols: number, rows: number, shell?: string): Promise<string>;
  async create(first: string | PtyCreateSpec, cwdArg?: string, colsArg?: number, rowsArg?: number, shellArg?: string): Promise<string> {
    const spec: PtyCreateSpec =
      typeof first === "string"
        ? { ownerId: first, cwd: cwdArg ?? "", cols: colsArg ?? 80, rows: rowsArg ?? 24, ...(shellArg !== undefined ? { shell: shellArg } : {}) }
        : first;
    const { ownerId, cwd, cols, rows, shell } = spec;
    if (spec.command !== undefined && spec.command.length > MAX_COMMAND_LENGTH) {
      throw new RpcException("invalid-params", `command longer than ${MAX_COMMAND_LENGTH} characters`);
    }
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
    env["TIDE_PTY_OWNER"] = ownerId;
    if (ownerId.startsWith("run:")) env["TIDE_RUN_PROJECT_ID"] = ownerId.slice(4);
    else env["TIDE_THREAD_ID"] = ownerId;
    Object.assign(env, spec.env ?? {});

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

    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const entry: Entry = {
      id,
      ownerId,
      label: spec.label,
      handle,
      exited,
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

    const typeCommand = this.#commandTyper(entry, spec.command);
    handle.onData((data) => {
      this.#readTitle(entry, data);
      this.#append(entry, data);
      for (const listener of [...entry.listeners]) listener({ kind: "data", data });
      typeCommand();
    });
    handle.onExit((exit) => {
      if (!entry.alive) return;
      entry.alive = false;
      entry.exit = exit;
      const chunk: PtyChunk = { kind: "exit", ...exit };
      for (const listener of [...entry.listeners]) listener(chunk);
      entry.listeners.clear();
      typeCommand.cancel();
      markExited();
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

  list(ownerId: string): PtyInfo[] {
    const out: PtyInfo[] = [];
    for (const entry of this.#ptys.values()) {
      if (entry.ownerId !== ownerId) continue;
      out.push({
        ptyId: entry.id,
        title: entry.title ?? entry.fallbackTitle,
        alive: entry.alive,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
      });
    }
    return out;
  }

  /** Shell pids of the owner's live terminals (those whose backend reports one). */
  pids(ownerId: string): number[] {
    const out: number[] = [];
    for (const entry of this.#ptys.values()) {
      if (entry.ownerId === ownerId && entry.alive && typeof entry.handle.pid === "number") out.push(entry.handle.pid);
    }
    return out;
  }

  /** The shell pid of a live terminal; undefined once it exited or when the backend does not know it. */
  pidOf(ptyId: string): number | undefined {
    const entry = this.#ptys.get(ptyId);
    return entry !== undefined && entry.alive ? entry.handle.pid : undefined;
  }

  alive(ptyId: string): boolean {
    return this.#ptys.get(ptyId)?.alive === true;
  }

  /** Kills every live terminal of an owner (its worktree is going away, or the thread was archived). */
  killOwner(ownerId: string): number {
    let killed = 0;
    for (const entry of this.#ptys.values()) {
      if (entry.ownerId !== ownerId || !entry.alive) continue;
      try {
        entry.handle.kill();
        killed++;
      } catch (err) {
        this.#log("[pty] kill failed", err);
      }
    }
    return killed;
  }

  killThread(threadId: string): number {
    return this.killOwner(threadId);
  }

  /**
   * Stops a terminal's process tree: SIGINT, wait, SIGTERM, wait, SIGKILL, wait. Each wait ends early
   * when the terminal exits. An interactive shell survives SIGINT/SIGTERM and abandons the rest of a
   * `cmd; exit` line when `cmd` dies of SIGINT, so once the shell has no children left it is hung up
   * (SIGHUP via `kill()`). Resolves once the terminal exited (or the last wait ran out).
   */
  async stop(ptyId: string, options: { graceMs?: number } = {}): Promise<void> {
    const entry = this.#require(ptyId);
    const grace = options.graceMs ?? STOP_GRACE_MS;
    const steps: TreeSignal[] = ["SIGINT", "SIGTERM", "SIGKILL"];
    for (const signal of steps) {
      if (!entry.alive) return;
      try {
        await entry.handle.killTree(signal);
      } catch (err) {
        this.#log(`[pty] ${signal} failed`, err);
      }
      for (let waited = 0; waited < grace && entry.alive; waited += this.#stopPollMs) {
        await Promise.race([entry.exited, this.#sleep(Math.min(this.#stopPollMs, grace - waited))]);
        if (!entry.alive) return;
        const pid = entry.handle.pid;
        if (signal === "SIGKILL" || pid === undefined) continue;
        const children = await this.#children(pid).catch(() => [1]);
        if (children.length > 0 || !entry.alive) continue;
        try {
          entry.handle.kill();
        } catch (err) {
          this.#log("[pty] hangup failed", err);
        }
        await Promise.race([entry.exited, this.#sleep(grace)]);
        if (!entry.alive) return;
      }
    }
  }

  /** `stop` for every live terminal of an owner, in parallel. */
  async stopOwner(ownerId: string, options: { graceMs?: number } = {}): Promise<void> {
    const live = [...this.#ptys.values()].filter((e) => e.ownerId === ownerId && e.alive);
    await Promise.all(live.map((e) => this.stop(e.id, options)));
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

  /** Types `command` once: on the first output chunk or after the delay, whichever comes first. */
  #commandTyper(entry: Entry, command: string | undefined): (() => void) & { cancel: () => void } {
    if (command === undefined || command.trim() === "") return Object.assign(() => undefined, { cancel: () => undefined });
    let sent = false;
    let cancelTimer: () => void = () => undefined;
    const send = (): void => {
      if (sent) return;
      sent = true;
      cancelTimer();
      if (entry.alive) entry.handle.write(` ${command}\n`);
    };
    cancelTimer = this.#schedule(send, this.#commandDelayMs);
    return Object.assign(send, {
      cancel: () => {
        sent = true;
        cancelTimer();
      },
    });
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
