import { Check, Errors } from "typebox/value";
import {
  Command as CommandSchema,
  applyRecord,
  emptyReadModel,
  newId as defaultNewId,
  replay,
  type Command,
  type EventRecord,
  type ReadModel,
} from "@tide/contracts";
import { decide } from "./decider/index.ts";
import type { EventStore } from "./store.ts";

/** Rejection carrying a stable machine code (invalid-command / not-found / conflict / busy). */
export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface EngineOptions {
  store: EventStore;
  now?: () => number;
  newId?: () => string;
}

export interface DispatchResult {
  seq: number;
  events: EventRecord[];
}

export type EventListener = (record: EventRecord) => void;

/**
 * Single-writer command engine. Every dispatch runs strictly serially, so the
 * event log order is total and the in-memory read model can never interleave.
 */
export class Engine {
  #store: EventStore;
  #now: () => number;
  #newId: () => string;
  #model: ReadModel;
  #listeners = new Set<EventListener>();
  /** tail of the serial processing chain; also the drain() handle */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: EngineOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#model = replay(emptyReadModel(), options.store.readAll());
  }

  getModel(): ReadModel {
    return this.#model;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispatch(command: Command): Promise<DispatchResult> {
    const run = this.#queue.then(() => this.#process(command));
    // keep the chain alive regardless of this command's outcome
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolves once every queued command has been processed. */
  async drain(): Promise<void> {
    // loop because a listener may enqueue further commands
    let previous: Promise<unknown> | undefined;
    while (previous !== this.#queue) {
      previous = this.#queue;
      await previous;
    }
  }

  async #process(command: Command): Promise<DispatchResult> {
    if (!Check(CommandSchema, command)) {
      const first = Errors(CommandSchema, command)[0];
      throw new CommandError("invalid-command", first?.message ?? "invalid command");
    }
    const ts = this.#now();
    const decision = decide(this.#model, command, { now: ts, newId: this.#newId });
    if (!decision.ok) throw new CommandError(decision.error.code, decision.error.message);
    if (decision.events.length === 0) return { seq: this.#model.seq, events: [] };

    const records = this.#store.append(decision.events, ts);
    for (const record of records) {
      this.#model = applyRecord(this.#model, record);
      for (const listener of this.#listeners) {
        try {
          listener(record);
        } catch (err) {
          console.error("[engine] listener failed", err);
        }
      }
    }
    return { seq: this.#model.seq, events: records };
  }
}
