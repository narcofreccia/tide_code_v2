import type { McpServerSpec, Project, ProviderKind, ProviderSession, ReadModel, SessionSettings, Thread } from "@tide/contracts";
import { composeSystemPromptAppend, linkedRepoPreamble, resolveLinkedDirs } from "./links.ts";
import type { DriverRegistry } from "./registry.ts";

const IDLE_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 60_000;

interface Entry {
  threadId: string;
  kind: ProviderKind;
  cwd: string;
  session: ProviderSession;
  /** what the harness is currently running with; compared against the thread on every turn */
  settings: SessionSettings;
  lastUsedAt: number;
}

export function settingsOf(thread: Thread): SessionSettings {
  return { ...(thread.model !== undefined ? { model: thread.model } : {}), mode: thread.mode, interaction: thread.interaction };
}

function sameSettings(a: SessionSettings, b: SessionSettings): boolean {
  return a.model === b.model && a.mode === b.mode && a.interaction === b.interaction;
}

export interface SessionDirectoryOptions {
  registry: DriverRegistry;
  now?: () => number;
  /** how long an untouched session survives */
  idleMs?: number;
  /** Tide's own MCP servers, added on top of the user's native config */
  mcpServers?: McpServerSpec[];
  /** per-thread MCP servers (the Tide board/delegation tools, carrying an agent token) */
  mcp?: { serversFor(threadId: string): McpServerSpec[]; revoke(threadId: string): void };
  /** false in tests: reapIdle() is then driven by hand against a manual clock */
  autoReap?: boolean;
  /** the live read model: who owns a native session id, and which threads have a turn in flight */
  model?: () => ReadModel;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * The provider a thread's `nativeSessionId` belongs to: the harness of its most recently
 * started turn. undefined when no turn has started yet (nothing to contradict the thread).
 */
export function nativeSessionOwner(model: ReadModel, threadId: string): ProviderKind | undefined {
  let owner: { provider: ProviderKind; at: number } | undefined;
  for (const turn of Object.values(model.turns)) {
    if (turn.threadId !== threadId || turn.provider === undefined || turn.startedAt === undefined) continue;
    if (owner === undefined || turn.startedAt >= owner.at) owner = { provider: turn.provider, at: turn.startedAt };
  }
  return owner?.provider;
}

/**
 * The native session id that may be resumed on the thread's *current* provider. A session id
 * minted by another harness is never handed over (the decider clears it on a provider switch;
 * this guards logs written before that rule and any other drift).
 */
export function resumableSessionId(thread: Thread, model?: ReadModel): string | undefined {
  if (thread.nativeSessionId === undefined) return undefined;
  if (model === undefined) return thread.nativeSessionId;
  const owner = nativeSessionOwner(model, thread.id);
  return owner === undefined || owner === thread.provider ? thread.nativeSessionId : undefined;
}

/** A turn is in flight on the thread: its session must survive however long the turn takes. */
export function hasLiveTurn(model: ReadModel, threadId: string): boolean {
  const thread = model.threads[threadId];
  if (!thread) return false;
  if (thread.status === "running") return true;
  const latest = thread.latestTurnId === undefined ? undefined : model.turns[thread.latestTurnId];
  return latest?.status === "requested" || latest?.status === "running";
}

/** A thread's cwd is its worktree once P2 lands, the repo root until then. */
export function threadCwd(thread: Thread, project: Project): string {
  return thread.worktreePath ?? project.rootPath;
}

/**
 * threadId -> live provider session. Sessions are reused across turns (so the
 * harness keeps its own context) and reaped when a thread goes quiet.
 */
export class SessionDirectory {
  #registry: DriverRegistry;
  #now: () => number;
  #idleMs: number;
  #mcpServers: McpServerSpec[];
  #mcp: { serversFor(threadId: string): McpServerSpec[]; revoke(threadId: string): void } | undefined;
  #log: (msg: string, data?: unknown) => void;
  #model: (() => ReadModel) | undefined;
  #entries = new Map<string, Entry>();
  #opening = new Map<string, Promise<ProviderSession>>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SessionDirectoryOptions) {
    this.#registry = options.registry;
    this.#now = options.now ?? (() => Date.now());
    this.#idleMs = options.idleMs ?? IDLE_MS;
    this.#mcpServers = options.mcpServers ?? [];
    this.#mcp = options.mcp;
    this.#log = options.log ?? (() => undefined);
    this.#model = options.model;
    if (options.autoReap ?? true) {
      this.#timer = setInterval(() => void this.reapIdle(), REAP_INTERVAL_MS);
      this.#timer.unref?.();
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  peek(threadId: string): ProviderSession | undefined {
    return this.#entries.get(threadId)?.session;
  }

  async getOrOpen(thread: Thread, project: Project): Promise<ProviderSession> {
    const cwd = threadCwd(thread, project);
    const existing = this.#entries.get(thread.id);
    if (existing) {
      if (existing.kind === thread.provider && existing.cwd === cwd) {
        const wanted = settingsOf(thread);
        if (sameSettings(existing.settings, wanted)) {
          existing.lastUsedAt = this.#now();
          return existing.session;
        }
        // model/mode/plan changed under a live session: switch in place when the driver can,
        // otherwise reopen (resume keeps the harness's own context)
        const result = existing.session.reconfigure ? await this.#reconfigure(existing, wanted) : "reopen";
        if (result === "applied") {
          existing.settings = wanted;
          existing.lastUsedAt = this.#now();
          return existing.session;
        }
        this.#log(`[provider] reopening ${thread.provider} session for ${thread.id} to apply new settings`);
      }
      // provider (or worktree, or settings) changed under the thread: drop the stale session
      await this.close(thread.id);
    }
    const inflight = this.#opening.get(thread.id);
    if (inflight) return inflight;

    const open = this.#open(thread, cwd, project).finally(() => this.#opening.delete(thread.id));
    this.#opening.set(thread.id, open);
    return open;
  }

  async #open(thread: Thread, cwd: string, project: Project): Promise<ProviderSession> {
    const instance = await this.#registry.get(thread.provider);
    const linkedDirs = resolveLinkedDirs(thread, project);
    const systemPromptAppend = composeSystemPromptAppend(linkedRepoPreamble(project, linkedDirs));
    const resume = resumableSessionId(thread, this.#model?.());
    const session = await instance.openSession({
      threadId: thread.id,
      cwd,
      ...(resume !== undefined ? { resume } : {}),
      ...(thread.model !== undefined ? { model: thread.model } : {}),
      mode: thread.mode,
      interaction: thread.interaction,
      mcpServers: [...this.#mcpServers, ...(this.#mcp?.serversFor(thread.id) ?? [])],
      ...(linkedDirs.length > 0 ? { linkedDirs } : {}),
      ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
    });
    this.#entries.set(thread.id, { threadId: thread.id, kind: thread.provider, cwd, session, settings: settingsOf(thread), lastUsedAt: this.#now() });
    return session;
  }

  async #reconfigure(entry: Entry, wanted: SessionSettings): Promise<"applied" | "reopen"> {
    try {
      return await entry.session.reconfigure!(wanted);
    } catch (err) {
      this.#log("[provider] reconfigure failed; reopening", err);
      return "reopen";
    }
  }

  touch(threadId: string): void {
    const entry = this.#entries.get(threadId);
    if (entry) entry.lastUsedAt = this.#now();
  }

  async close(threadId: string): Promise<void> {
    const entry = this.#entries.get(threadId);
    if (!entry) return;
    this.#entries.delete(threadId);
    // the agent token only lives as long as the harness process that was handed it
    this.#mcp?.revoke(threadId);
    try {
      await entry.session.close();
    } catch (err) {
      this.#log("[provider] session close failed", err);
    }
  }

  /**
   * Closes every session untouched for longer than idleMs. A thread with a turn in flight is
   * never reaped, however long the harness has been quiet (a long tool call emits nothing).
   */
  async reapIdle(): Promise<string[]> {
    const cutoff = this.#now() - this.#idleMs;
    const model = this.#model?.();
    const stale = [...this.#entries.values()]
      .filter((e) => e.lastUsedAt <= cutoff && !(model !== undefined && hasLiveTurn(model, e.threadId)))
      .map((e) => e.threadId);
    for (const threadId of stale) await this.close(threadId);
    return stale;
  }

  async closeAll(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const threadId of [...this.#entries.keys()]) await this.close(threadId);
  }
}
