import type { OpencodeApi } from "./types.ts";
import type { OpencodeEvent } from "./wire.ts";

export interface HubListener {
  onEvent(event: OpencodeEvent): void;
  /** the stream ended or failed; the next `ensure()` resubscribes */
  onStreamEnd(reason: string): void;
}

/** The session an event belongs to, when it names one (`data.sessionID`, or a form's). */
export function eventSessionId(event: OpencodeEvent): string | undefined {
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const direct = (data as { sessionID?: unknown }).sessionID;
  if (typeof direct === "string") return direct;
  const form = (data as { form?: { sessionID?: unknown } }).form;
  if (typeof form?.sessionID === "string") return form.sessionID;
  const info = (data as { info?: { metadata?: { sessionID?: unknown } } }).info;
  return typeof info?.metadata?.sessionID === "string" ? info.metadata.sessionID : undefined;
}

/**
 * One `GET /api/event` subscription per driver instance. OpenCode 2's event stream is
 * server-wide (no directory or session filter — verified on 2.0.27), so N threads on one
 * stream each would be N copies of every event. Events are routed by session id; events that
 * name no session are offered to listeners that asked for them (`wantsUnscoped`).
 */
export class EventHub {
  #api: () => Promise<OpencodeApi>;
  #log: (msg: string) => void;
  #listeners = new Map<string, Set<HubListener>>();
  #unscoped = new Set<HubListener>();
  #abort: AbortController | undefined;
  #running: Promise<void> | undefined;
  #connecting: Promise<void> | undefined;
  #onDead: () => void;

  constructor(api: () => Promise<OpencodeApi>, log: (msg: string) => void, onDead: () => void = () => undefined) {
    this.#api = api;
    this.#log = log;
    this.#onDead = onDead;
  }

  add(sessionId: string, listener: HubListener, wantsUnscoped = false): () => void {
    const set = this.#listeners.get(sessionId) ?? new Set<HubListener>();
    set.add(listener);
    this.#listeners.set(sessionId, set);
    if (wantsUnscoped) this.#unscoped.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(sessionId);
      this.#unscoped.delete(listener);
    };
  }

  /** Subscribes if not already subscribed; resolves once the stream is open. */
  async ensure(): Promise<void> {
    if (this.#running) return;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    const abort = new AbortController();
    const stream = await (await this.#api()).subscribe({ signal: abort.signal });
    this.#abort = abort;
    this.#running = (async () => {
      let reason = "opencode event stream ended";
      try {
        for await (const event of stream) this.#dispatch(event);
      } catch (error) {
        reason = `opencode event stream failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.#running = undefined;
      this.#abort = undefined;
      if (abort.signal.aborted) return;
      this.#log(`[opencode] ${reason}; the next turn resubscribes`);
      this.#onDead();
      for (const set of [...this.#listeners.values()]) for (const listener of [...set]) listener.onStreamEnd(reason);
    })();
  }

  #dispatch(event: OpencodeEvent): void {
    const sessionId = eventSessionId(event);
    if (sessionId === undefined) {
      for (const listener of [...this.#unscoped]) listener.onEvent(event);
      return;
    }
    for (const listener of [...(this.#listeners.get(sessionId) ?? [])]) listener.onEvent(event);
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#running?.catch(() => undefined);
    this.#running = undefined;
  }
}
