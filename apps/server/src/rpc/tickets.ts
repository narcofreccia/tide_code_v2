import { randomBytes } from "node:crypto";

export interface Ticket {
  ticket: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;

/** Short-lived single-use tickets so a browser can open a WebSocket without a header. */
export class TicketIssuer {
  #ttlMs: number;
  #now: () => number;
  #issued = new Map<string, { kind: string; expiresAt: number }>();

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  issue(kind: "websocket"): Ticket {
    this.#sweep();
    const ticket = randomBytes(32).toString("hex");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#issued.set(ticket, { kind, expiresAt });
    return { ticket, expiresAt };
  }

  /** Returns true exactly once per valid, unexpired ticket. */
  consume(ticket: string): boolean {
    const entry = this.#issued.get(ticket);
    if (!entry) return false;
    this.#issued.delete(ticket);
    return entry.expiresAt > this.#now();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [ticket, entry] of this.#issued) if (entry.expiresAt <= now) this.#issued.delete(ticket);
  }
}
