import { Check, Errors } from "typebox/value";
import {
  Command as CommandSchema,
  DomainEvent as DomainEventSchema,
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
import { Compactor, type CompactionStats } from "./compaction.ts";
import type { EventStore } from "./store.ts";

/** Every `type` literal the command union accepts, flattened across its nested unions. */
const KNOWN_COMMAND_TYPES: ReadonlySet<string> = new Set(
  CommandSchema.anyOf.flatMap((member) =>
    (member as { anyOf?: Array<{ properties?: { type?: { const?: unknown } } }> }).anyOf?.flatMap((m) =>
      typeof m.properties?.type?.const === "string" ? [m.properties.type.const] : [],
    ) ?? [],
  ),
);

/** Every event `type` this build projects; anything else in the log came from a newer server. */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  DomainEventSchema.anyOf.flatMap((m) => {
    const type = (m as { properties?: { type?: { const?: unknown } } }).properties?.type?.const;
    return typeof type === "string" ? [type] : [];
  }),
);

const SNAPSHOT_TAG = "snapshot_tag";

/** Events appended between two automatic snapshots. */
export const DEFAULT_SNAPSHOT_EVERY = 5_000;

const SETTLED_STATUSES: ReadonlySet<string> = new Set(["completed", "interrupted", "error"]);

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
  /** events appended before an automatic snapshot (0 = only explicit `snapshot()` calls) */
  snapshotEvery?: number;
  /**
   * Identifies the code that wrote a snapshot (the app passes the build version). A snapshot is
   * loaded only when the tag stored with it equals this one, so a new build always replays once
   * and a forgotten `MODEL_SCHEMA` bump cannot serve a stale model. `null` = never load one
   * (source runs, where the projector changes without a version change). Undefined = no check.
   */
  snapshotTag?: string | null;
  /** compact settled turns' text deltas after each settle (default on; `compact()` works either way) */
  compaction?: boolean;
  log?: (msg: string) => void;
}

export interface SnapshotResult {
  seq: number;
  bytes: number;
  ms: number;
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
  #log: (msg: string) => void;
  #snapshotEvery: number;
  #snapshotTag: string | null | undefined;
  /** events appended since the newest snapshot */
  #sinceSnapshot = 0;
  /** boot replayed from the start although a tag is set: the stored snapshot (if any) is not this build's */
  #snapshotStale = false;
  #compactor: Compactor;
  #autoCompact: boolean;
  /** threads with a turn settled since the last maintenance step */
  #settledThreads = new Set<string>();

  constructor(options: EngineOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#defaults = options.defaults ?? (() => ({}));
    this.#handoffCap = "handoffCap" in options ? options.handoffCap : handoffCapFromEnv();
    this.#log = options.log ?? ((msg) => console.log(msg));
    this.#snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    this.#snapshotTag = options.snapshotTag;
    this.#model = this.#boot();
    this.#autoCompact = options.compaction !== false;
    this.#compactor = new Compactor(this.#store.compaction, (turnId) => {
      const turn = this.#model.turns[turnId];
      return turn === undefined || SETTLED_STATUSES.has(turn.status);
    });
  }

  /** Newest usable snapshot + the events after it; a full replay when there is none. */
  #boot(): ReadModel {
    const lastSeq = this.#store.lastSeq();
    if (lastSeq === 0) return emptyReadModel();
    const started = performance.now();
    const tag = this.#snapshotTag;
    const usable = tag === undefined || (tag !== null && this.#store.getMeta(SNAPSHOT_TAG) === tag);
    const snapshot = usable ? this.#store.snapshots.load(lastSeq, (msg) => console.warn(msg)) : undefined;
    const tail = this.#store.readFrom((snapshot?.seq ?? 0) + 1);
    const unknown = new Map<string, number>();
    for (const record of tail) {
      if (!KNOWN_EVENT_TYPES.has(record.event.type)) unknown.set(record.event.type, (unknown.get(record.event.type) ?? 0) + 1);
    }
    if (unknown.size > 0) {
      const total = [...unknown.values()].reduce((a, b) => a + b, 0);
      console.warn(`[engine] ${total} events of types this server does not know were skipped (${[...unknown.entries()].map(([t, n]) => `${t}×${n}`).join(", ")}); a newer Tide wrote them`);
    }
    const model = replay(snapshot?.model ?? emptyReadModel(), tail);
    this.#sinceSnapshot = tail.length;
    this.#snapshotStale = typeof tag === "string" && snapshot === undefined;
    const ms = Math.round(performance.now() - started);
    this.#log(
      snapshot !== undefined
        ? `[engine] replayed ${tail.length} events from snapshot at seq ${snapshot.seq} (${ms} ms)`
        : `[engine] replayed ${tail.length} events from the start, no snapshot (${ms} ms)`,
    );
    return model;
  }

  /**
   * True after a boot that could not use the stored snapshot (none, or another build's): the app
   * writes one right away so the next boot is fast even if this process never shuts down cleanly.
   */
  get snapshotStale(): boolean {
    return this.#snapshotStale;
  }

  /**
   * Writes the current model as a snapshot (no-op when the newest one is already at this seq and
   * was written by this build). Synchronous: it runs between commands, so the model it serialises
   * is never mid-dispatch.
   */
  snapshot(): SnapshotResult | undefined {
    const seq = this.#model.seq;
    if (seq === 0 || (!this.#snapshotStale && seq <= this.#store.snapshots.latestSeq())) return undefined;
    const started = performance.now();
    const bytes = this.#store.snapshots.write(seq, JSON.stringify(this.#model), this.#now());
    if (typeof this.#snapshotTag === "string") this.#store.setMeta(SNAPSHOT_TAG, this.#snapshotTag);
    this.#sinceSnapshot = 0;
    this.#snapshotStale = false;
    return { seq, bytes, ms: performance.now() - started };
  }

  /** Compacts every settled turn after the stored watermark (boot runs this once). */
  compact(): CompactionStats {
    return this.#compactor.all();
  }

  /** After a command: compaction of freshly settled threads, then a snapshot past the threshold. */
  #maintain(): void {
    if (this.#settledThreads.size > 0 && this.#autoCompact) {
      const threads = [...this.#settledThreads];
      this.#settledThreads.clear();
      try {
        const idle = Object.values(this.#model.turns).every((t) => t.status === "queued" || SETTLED_STATUSES.has(t.status));
        // nothing running anywhere: one pass from the watermark also moves it forward
        if (idle) this.#compactor.all();
        else for (const threadId of threads) this.#compactor.thread(threadId);
      } catch (err) {
        console.error("[engine] compaction failed", err);
      }
    }
    if (this.#snapshotEvery > 0 && this.#sinceSnapshot >= this.#snapshotEvery) {
      try {
        this.snapshot();
      } catch (err) {
        this.#sinceSnapshot = 0; // retried after the next window, not after every command
        console.error("[engine] snapshot failed", err);
      }
    }
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
    // keep the chain alive regardless of this command's outcome; maintenance is its own step,
    // one tick later, so the caller's continuation runs before compaction or a snapshot
    this.#queue = run
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => this.#maintain());
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
    this.#sinceSnapshot += records.length;
    for (const record of records) {
      this.#model = applyRecord(this.#model, record);
      if (record.event.type === "turn.settled" && this.#autoCompact) this.#settledThreads.add(record.event.threadId);
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
