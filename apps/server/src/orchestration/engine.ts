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
import { decide, type DecideDefaults } from "./decider/index.ts";
import { handoffCapFromEnv } from "./handoff/select.ts";
import type { EventStore } from "./store.ts";

/** Every `type` literal the command union accepts, flattened across its nested unions. */
const KNOWN_COMMAND_TYPES: ReadonlySet<string> = new Set(
  CommandSchema.anyOf.flatMap((member) =>
    (member as { anyOf?: Array<{ properties?: { type?: { const?: unknown } } }> }).anyOf?.flatMap((m) =>
      typeof m.properties?.type?.const === "string" ? [m.properties.type.const] : [],
    ) ?? [],
  ),
);

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
  /** user settings the decider reads (limit policy, worktree/provider defaults); read per command */
  defaults?: () => DecideDefaults;
  /** upper bound for recorded handoffs; defaults to `TIDE_HANDOFF_TOKEN_CAP` */
  handoffCap?: number | undefined;
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
  #defaults: () => DecideDefaults;
  #handoffCap: number | undefined;
  #model: ReadModel;
  #listeners = new Set<EventListener>();
  /** tail of the serial processing chain; also the drain() handle */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: EngineOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#defaults = options.defaults ?? (() => ({}));
    this.#handoffCap = "handoffCap" in options ? options.handoffCap : handoffCapFromEnv();
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
    return this.#enqueue(command);
  }

  /**
   * Entry point for the server's own commands (see `decider/server.ts`). It shares the
   * single-writer queue and the decider with `dispatch`, but skips contracts validation
   * because these types are intentionally outside the wire `Command` union — which is also
   * why no RPC handler can ever reach this method.
   */

  #enqueue(command: Command): Promise<DispatchResult> {
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
      // a union error names the first member's missing fields, which says nothing about an
      // unknown type (typically a client newer than the server)
      const type = (command as { type?: unknown } | null)?.type;
      if (typeof type === "string" && !KNOWN_COMMAND_TYPES.has(type)) {
        throw new CommandError("invalid-command", `unknown command type "${type}" (is the server older than the client? restart it)`);
      }
      const first = Errors(CommandSchema, command)[0];
      throw new CommandError("invalid-command", first?.message ?? "invalid command");
    }
    const commandId = "commandId" in command && typeof command.commandId === "string" ? command.commandId : undefined;
    if (commandId !== undefined) {
      const receipt = this.#store.getReceipt(commandId);
      if (receipt !== undefined) {
        return { seq: receipt.lastSeq || this.#model.seq, events: this.#store.readRange(receipt.firstSeq, receipt.lastSeq) };
      }
    }
    const ts = this.#now();
    const decision = decide(this.#model, command, { ...this.#defaults(), now: ts, newId: this.#newId, ...(this.#handoffCap !== undefined ? { handoffCap: this.#handoffCap } : {}) });
    if (!decision.ok) throw new CommandError(decision.error.code, decision.error.message);
    if (decision.events.length === 0 && commandId === undefined) return { seq: this.#model.seq, events: [] };

    const records = this.#store.append(decision.events, ts, commandId === undefined ? undefined : { commandId });
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
