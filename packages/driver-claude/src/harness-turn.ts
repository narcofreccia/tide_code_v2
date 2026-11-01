import { randomUUID } from "node:crypto";
import type { HarnessTurnHandle, NormalizedEvent } from "@tide/contracts";
import { AsyncQueue, deferred, type Deferred } from "./async-queue.ts";
import type { LedgerTurn } from "./rollback.ts";

export type HarnessTurnListener = (turn: HarnessTurnHandle) => void;

export const CONTINUED_REASON = "Claude Code continued on its own";

/** Bookkeeping kept from idle reading, replayed at the head of the next harness turn. */
const MAX_PREAMBLE = 50;

/**
 * Whether an event read while no turn runs means Claude Code started working on its own.
 * Text, reasoning, tool calls, plans and prompts do; a sub-agent's *settle* does (it is what
 * wakes the model). Bookkeeping does not: session ids, usage/rate-limit gauges, command lists,
 * pass-through `info` rows and progress pings of a background child that is still running.
 */
export function isSubstantive(event: NormalizedEvent): boolean {
  switch (event.type) {
    case "assistant.delta":
    case "assistant.reasoning":
    case "plan.proposed":
    case "plan.progress":
      return true;
    case "activity": {
      const activity = event.activity;
      if (activity.kind === "info") return false;
      if (activity.kind === "child") return activity.status !== "running";
      // a background sub-agent's own tool calls stream while it works; only its report wakes the model
      if (activity.kind === "tool" && activity.parentToolUseId !== undefined && activity.parentToolUseId !== null) return false;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Non-substantive activity of a background sub-agent: its child row while not settled, or a
 * tool call it makes (`parentToolUseId` set). Streamed live between turns, never preambled.
 */
export function isIdleActivity(event: NormalizedEvent): boolean {
  if (event.type !== "activity" || isSubstantive(event)) return false;
  const activity = event.activity;
  if (activity.kind === "child") return true;
  return activity.kind === "tool" && activity.parentToolUseId !== undefined && activity.parentToolUseId !== null;
}

export function reportedReason(name: string): string {
  return `sub-agent "${name}" reported`;
}

/** A turn the harness started by itself: its own mailbox, ended by the next `result`. */
export class HarnessTurn implements LedgerTurn {
  readonly reason: string;
  /** opaque id handed to the server, which names this turn when it steers into it */
  readonly key = randomUUID();
  /** uuid of the turn's first transcript entry, once read (its turn start for rollback) */
  start: string | undefined;
  readonly mailbox = new AsyncQueue<NormalizedEvent>();
  /** uuids of messages steered into this turn the CLI has not reported consuming yet */
  readonly pendingSteers = new Set<string>();
  /**
   * Set once the turn's final `result` is read (or the turn is abandoned): a steer pushed now
   * would run after the turn, outside it, so `steer()` refuses and the server queues it instead.
   */
  ending = false;
  readonly #done: Deferred<void> = deferred<void>();

  constructor(reason: string) {
    this.reason = reason;
  }

  /** resolves once the turn's `settled` is pushed (or the turn is abandoned) */
  get done(): Promise<void> {
    return this.#done.promise;
  }

  push(event: NormalizedEvent): void {
    this.mailbox.push(event);
  }

  finish(): void {
    this.ending = true;
    this.mailbox.close();
    this.#done.resolve();
  }
}

/**
 * Idle-time bookkeeping events. Child progress collapses to the latest row per child so a
 * background agent pinging for minutes cannot grow it; the rest is capped.
 */
export class Preamble {
  #events: NormalizedEvent[] = [];

  add(event: NormalizedEvent): void {
    if (event.type === "session") return; // applied by the session, never replayed
    if (event.type === "activity" && event.activity.kind === "child") {
      const key = event.activity.childKey;
      this.#events = this.#events.filter((e) => !(e.type === "activity" && e.activity.kind === "child" && e.activity.childKey === key));
    }
    this.#events.push(event);
    if (this.#events.length > MAX_PREAMBLE) this.#events.shift();
  }

  take(): NormalizedEvent[] {
    return this.#events.splice(0);
  }

  clear(): void {
    this.#events = [];
  }
}
