import type { NormalizedEvent } from "@tide/contracts";
import { AsyncQueue, deferred, type Deferred } from "./async-queue.ts";

export type HarnessTurnListener = (turn: { reason: string; events: AsyncIterable<NormalizedEvent> }) => void;

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

export function reportedReason(name: string): string {
  return `sub-agent "${name}" reported`;
}

/** A turn the harness started by itself: its own mailbox, ended by the next `result`. */
export class HarnessTurn {
  readonly reason: string;
  readonly mailbox = new AsyncQueue<NormalizedEvent>();
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
