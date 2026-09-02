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

/**
 * Providers that cannot host a Tide MCP session yet (driver-pi reports `caps.mcp:false` and
 * never receives the Tide MCP server), so they can neither sit on an experts panel nor be
 * delegated to: they would hang `working` forever with no way to report back.
 */
export const NO_TIDE_MCP: readonly string[] = ["pi"];
export const NO_TIDE_MCP_MESSAGE = "pi has no Tide MCP bridge yet; choose claude, codex or opencode";
export const lacksTideMcp = (provider: string): boolean => NO_TIDE_MCP.includes(provider);
