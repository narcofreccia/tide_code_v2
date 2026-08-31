import type { EventRecord, ExpertsMessage, ExpertsSession, ReadModel } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { messageDeliveryPrompt } from "./prompts.ts";

export interface ExpertsReactorOptions {
  engine: Engine;
  log?: (msg: string, data?: unknown) => void;
}

interface Recipient {
  key: string;
  threadId: string;
}

/** Board recipients of a message, minus its author. */
function recipientsOf(session: ExpertsSession, message: ExpertsMessage): Recipient[] {
  const all: Recipient[] = [];
  for (const expert of session.experts) if (expert.threadId !== undefined) all.push({ key: expert.key, threadId: expert.threadId });
  if (session.lead.threadId !== undefined) all.push({ key: "lead", threadId: session.lead.threadId });
  const targeted = message.to === "all" ? all : all.filter((r) => r.key === message.to);
  return targeted.filter((r) => r.key !== message.from);
}

function sessionOfThread(model: ReadModel, threadId: string): ExpertsSession | undefined {
  const id = model.threads[threadId]?.expertsSessionId;
  return id === undefined ? undefined : model.expertsSessions[id];
}

/**
 * Delivers board traffic to the panel. Messages land on an idle expert as a new turn;
 * an expert mid-turn keeps a per-thread mailbox that is flushed when its turn settles.
 * Everything goes through the engine — the reactor never touches a driver.
 */
export class ExpertsReactor {
  #engine: Engine;
  #log: (msg: string, data?: unknown) => void;
  /** threadId -> messages waiting for the thread to go idle */
  #mailbox = new Map<string, string[]>();
  #queues = new Map<string, Promise<void>>();
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ExpertsReactorOptions) {
    this.#engine = options.engine;
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Resolves when the engine is drained and no delivery is in flight. */
  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) {
        await this.#engine.drain();
        if (this.#inflight.size === 0) return;
        continue;
      }
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("experts reactor did not drain");
  }

  /** Messages buffered for a thread; exposed for tests and diagnostics. */
  pending(threadId: string): readonly string[] {
    return this.#mailbox.get(threadId) ?? [];
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type === "experts.message-posted") {
      const model = this.#engine.getModel();
      const session = model.expertsSessions[event.message.sessionId];
      if (!session) return;
      for (const recipient of recipientsOf(session, event.message)) {
        this.#buffer(recipient.threadId, messageDeliveryPrompt(event.message.from, event.message.text));
        this.#enqueue(recipient.threadId, () => this.#deliver(recipient.threadId));
      }
      return;
    }
    if (event.type === "turn.settled") {
      const model = this.#engine.getModel();
      const thread = model.threads[event.threadId];
      const session = sessionOfThread(model, event.threadId);
      if (session && thread?.role === "expert") {
        const expert = session.experts.find((e) => e.threadId === thread.id);
        if (expert) {
          this.#track(
            this.#dispatch({
              type: "experts.expert.status",
              sessionId: session.id,
              key: expert.key,
              status: event.status === "error" ? "error" : "idle",
            }),
          );
        }
      }
      if (session) this.#enqueue(event.threadId, () => this.#deliver(event.threadId));
    }
  }

  #buffer(threadId: string, text: string): void {
    const list = this.#mailbox.get(threadId) ?? [];
    list.push(text);
    this.#mailbox.set(threadId, list);
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  /** One delivery at a time per thread, so two messages cannot race into `busy`. */
  #enqueue(threadId: string, task: () => Promise<void>): void {
    const queue = (this.#queues.get(threadId) ?? Promise.resolve())
      .then(task)
      .catch((err: unknown) => this.#log("[experts] delivery failed", err));
    this.#queues.set(threadId, queue);
    this.#track(queue);
  }

  async #deliver(threadId: string): Promise<void> {
    const buffered = this.#mailbox.get(threadId);
    if (!buffered || buffered.length === 0) return;
    const thread = this.#engine.getModel().threads[threadId];
    if (!thread || thread.archivedAt !== undefined) {
      this.#mailbox.delete(threadId);
      return;
    }
    if (thread.status === "running") return; // flushed when the turn settles
    const text = buffered.join("\n\n");
    this.#mailbox.delete(threadId);
    try {
      await this.#engine.dispatch({ type: "turn.request", threadId, text });
    } catch (err) {
      // put it back so a later settle retries rather than dropping the message
      const list = this.#mailbox.get(threadId) ?? [];
      this.#mailbox.set(threadId, [...buffered, ...list]);
      this.#log("[experts] message delivery rejected", err);
    }
  }

  async #dispatch(command: Parameters<Engine["dispatch"]>[0]): Promise<void> {
    try {
      await this.#engine.dispatch(command);
    } catch (err) {
      this.#log(`[experts] ${command.type} rejected`, err);
    }
  }
}
