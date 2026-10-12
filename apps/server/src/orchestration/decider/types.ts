import type { DomainEvent, EventOf, Message, Turn } from "@tide/contracts";

export interface DecideContext {
  now: number;
  newId: () => string;
}

export interface DecideError {
  code: string;
  message: string;
}

export type DecideResult =
  | { ok: true; events: DomainEvent[] }
  | { ok: false; error: DecideError };

export const ok = (...events: DomainEvent[]): DecideResult => ({ ok: true, events });
export const fail = (code: string, message: string): DecideResult => ({ ok: false, error: { code, message } });

export const isArchived = (e: { archivedAt?: number }): boolean => e.archivedAt !== undefined;

/** Builds the `turn.requested` event that seeds a thread with `text`. */
export function turnRequested(threadId: string, text: string, ctx: DecideContext): EventOf<"turn.requested"> {
  const turn: Turn = { id: ctx.newId(), threadId, status: "requested", requestedAt: ctx.now };
  const userMessage: Message = { id: ctx.newId(), threadId, turnId: turn.id, role: "user", text, createdAt: ctx.now };
  return { type: "turn.requested", turn, userMessage };
}
