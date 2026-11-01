import type { NormalizedEvent } from "@tide/contracts";
import type { HarnessTurn } from "./sessions.ts";

/**
 * Consumes a harness turn nobody will render, so the driver can release its buffer, and tells
 * the driver the turn is not a Tide turn (its rollback counts must not include it).
 */
export async function dismissHarnessTurn(turn: HarnessTurn, log: (msg: string, data?: unknown) => void): Promise<void> {
  try {
    turn.dismiss?.();
  } catch (err) {
    log("[reactor] dismissing a harness turn failed", err);
  }
  await drainEvents(turn.events, log);
}

async function drainEvents(events: AsyncIterable<NormalizedEvent>, log: (msg: string, data?: unknown) => void): Promise<void> {
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
  #pending = new Map<string, { threadId: string; turn: HarnessTurn }>();

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
    this.#pending.set(turnId, { threadId, turn });
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

  /** The harness turn bound to `turnId`, removed from the queue (undefined for a user turn). */
  take(turnId: string): HarnessTurn | undefined {
    const bound = this.#pending.get(turnId);
    this.#pending.delete(turnId);
    return bound?.turn;
  }

  /** Whether a harness turn of `threadId` is offered or claimed but not running yet. */
  hasPending(threadId: string): boolean {
    if ((this.#waiting.get(threadId)?.length ?? 0) > 0) return true;
    for (const bound of this.#pending.values()) if (bound.threadId === threadId) return true;
    return false;
  }

  #shift(threadId: string): HarnessTurn | undefined {
    const list = this.#waiting.get(threadId);
    const turn = list?.shift();
    if (list !== undefined && list.length === 0) this.#waiting.delete(threadId);
    return turn;
  }
}

/**
 * A steer the user aimed at a harness turn that ended in the harness while the next one was
 * already running there. The steer falls back to a queued turn first (so it is never lost), and
 * that queued turn is promoted into the next harness turn once it runs in Tide: the message is
 * then recorded inside the turn the harness folds it into.
 */
export class SteerRetargets {
  /** messageId -> the thread and the turn the steer was meant for */
  #refused = new Map<string, { threadId: string; fromTurnId: string }>();
  /** threadId -> queued fallback turns to promote into the next harness turn */
  #waiting = new Map<string, Set<string>>();

  /** The harness moved past the steer's turn while another harness turn waits: retarget its fallback. */
  refused(messageId: string, threadId: string, fromTurnId: string): void {
    this.#refused.set(messageId, { threadId, fromTurnId });
  }

  /**
   * The steer fell back to `turnId`. When it was refused for a later harness turn and the
   * fallback is queued, the turn waits to be promoted (a `requested` one simply runs) and the
   * steer's origin is returned.
   */
  fellBack(messageId: string, turnId: string, queued: boolean): { threadId: string; fromTurnId: string } | undefined {
    const refused = this.#refused.get(messageId);
    this.#refused.delete(messageId);
    if (refused === undefined || !queued) return undefined;
    const set = this.#waiting.get(refused.threadId) ?? new Set<string>();
    set.add(turnId);
    this.#waiting.set(refused.threadId, set);
    return refused;
  }

  /** The queued turns to promote now that a harness turn runs on `threadId` (each handed out once). */
  take(threadId: string): string[] {
    const set = this.#waiting.get(threadId);
    this.#waiting.delete(threadId);
    return set === undefined ? [] : [...set];
  }

  /** The turn ran (or left the queue) on its own: nothing to promote. */
  forget(threadId: string, turnId: string): void {
    const set = this.#waiting.get(threadId);
    set?.delete(turnId);
    if (set !== undefined && set.size === 0) this.#waiting.delete(threadId);
  }
}
