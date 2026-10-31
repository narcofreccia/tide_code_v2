import type { NormalizedEvent } from "@tide/contracts";
import type { HarnessTurn } from "./sessions.ts";

/** Consumes a harness turn nobody will render, so the driver can release its buffer. */
export async function drainEvents(events: AsyncIterable<NormalizedEvent>, log: (msg: string, data?: unknown) => void): Promise<void> {
  try {
    for await (const _ of events) {
      // discarded
    }
  } catch (err) {
    log("[reactor] draining a harness turn failed", err);
  }
}

/**
 * R14: event streams of turns the harness started by itself, waiting to be run as ordinary
 * Tide turns. A stream is claimed per thread (FIFO) by the `turn.requested` its
 * `turn.request` produced — the engine publishes that event before `dispatch` resolves, so
 * the claim cannot wait for the dispatch result — and then held by turnId until `#runTurn`
 * consumes it instead of calling `session.send`.
 */
export class HarnessTurnQueue {
  #waiting = new Map<string, HarnessTurn[]>();
  #pending = new Map<string, AsyncIterable<NormalizedEvent>>();

  /** Registers a harness turn about to be requested on `threadId`. */
  offer(threadId: string, turn: HarnessTurn): void {
    const list = this.#waiting.get(threadId) ?? [];
    list.push(turn);
    this.#waiting.set(threadId, list);
  }

  /** The `turn.requested` of a harness notification arrived: bind the oldest waiting stream to it. */
  claim(threadId: string, turnId: string): boolean {
    const turn = this.#shift(threadId);
    if (turn === undefined) return false;
    this.#pending.set(turnId, turn.events);
    return true;
  }

  /** The request was refused: the offered stream never got a turn. */
  withdraw(threadId: string, turn: HarnessTurn): boolean {
    const list = this.#waiting.get(threadId);
    const i = list?.indexOf(turn) ?? -1;
    if (list === undefined || i < 0) return false;
    list.splice(i, 1);
    if (list.length === 0) this.#waiting.delete(threadId);
    return true;
  }

  /** The stream bound to `turnId`, removed from the queue (undefined for a user turn). */
  take(turnId: string): AsyncIterable<NormalizedEvent> | undefined {
    const events = this.#pending.get(turnId);
    this.#pending.delete(turnId);
    return events;
  }

  #shift(threadId: string): HarnessTurn | undefined {
    const list = this.#waiting.get(threadId);
    const turn = list?.shift();
    if (list !== undefined && list.length === 0) this.#waiting.delete(threadId);
    return turn;
  }
}
