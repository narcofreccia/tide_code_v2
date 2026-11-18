import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "@tide/contracts";
import { AsyncQueue, deferred } from "./async-queue.ts";
import type { LedgerEntry } from "./turn-ledger.ts";

export const CONTINUED_REASON = "Codex continued on its own";

/** One line for the notice of a harness turn opened by a sub-agent's request. */
export function requestReason(kind: "approval" | "user-input", name: string | undefined): string {
  const who = name !== undefined ? `sub-agent "${name}"` : "Codex";
  return kind === "approval" ? `${who} needs approval` : `${who} asks a question`;
}

/** A pending approval or question card, the only thing between turns that needs an open turn. */
export function pendingRequest(event: NormalizedEvent): Extract<NormalizedEvent, { type: "activity" }>["activity"] | undefined {
  if (event.type !== "activity") return undefined;
  const activity = event.activity;
  return (activity.kind === "approval" || activity.kind === "user-input") && activity.status === "pending" ? activity : undefined;
}

/**
 * Between turns, what a sub-agent does on its own: its child row (progress, and its final
 * row when it finishes) and every row it produces (`parentToolUseId` = its thread id).
 * Delivered live through `onIdleActivity`; the server lands them on the child's row.
 */
export function isIdleActivity(event: NormalizedEvent): boolean {
  if (event.type !== "activity" || pendingRequest(event) !== undefined) return false;
  return event.activity.kind === "child" || event.activity.parentToolUseId != null;
}

/**
 * A turn Tide did not start with `send`. Two things open one between turns:
 * - a sub-agent's approval or question (the parent model is idle and Codex does not wake it).
 *   There is no Codex turn behind it; it settles once every request it carries is answered or
 *   withdrawn, and the sub-agent's later rows go back to idle activity.
 * - the parent thread starting a turn of its own (`turn/started` on the session's thread with
 *   no `send` running). It has a native turn and settles on that turn's `turn/completed`.
 * A request arriving while the parent's own turn runs in here joins it; a parent turn starting
 * while requests are open turns it into a native one.
 */
export class CodexHarnessTurn {
  readonly reason: string;
  readonly key = randomUUID();
  readonly mailbox = new AsyncQueue<NormalizedEvent>();
  /** request ids this turn still waits on */
  readonly requests = new Set<string>();
  /** the parent's own turn ended while a request still held this turn open */
  nativeSettled: Extract<NormalizedEvent, { type: "settled" }> | undefined;
  /** this turn in the session's rollback ledger */
  readonly entry: LedgerEntry;
  #finished = false;
  readonly #done = deferred<void>();

  constructor(reason: string, entry: LedgerEntry) {
    this.reason = reason;
    this.entry = entry;
  }

  /** the parent's own Codex turn, when the model runs in this turn */
  get nativeTurnId(): string | undefined {
    return this.entry.native;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** resolves once the turn's `settled` is pushed */
  get done(): Promise<void> {
    return this.#done.promise;
  }

  push(event: NormalizedEvent): void {
    const request = pendingRequest(event);
    if (request !== undefined && (request.kind === "approval" || request.kind === "user-input")) this.requests.add(request.requestId);
    this.mailbox.push(event);
  }

  /** Pushes `settled` and ends the turn's events. */
  settle(event: Extract<NormalizedEvent, { type: "settled" }>): void {
    if (this.#finished) return;
    this.#finished = true;
    this.mailbox.push(event);
    this.mailbox.close();
    this.#done.resolve();
  }
}
