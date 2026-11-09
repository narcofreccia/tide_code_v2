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
  #issued = new Map<string, { kind: string; expiresAt: number; clientId?: string }>();

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** `clientId`: the paired device whose token bought the ticket (R17); omitted for the master token. */
  issue(kind: "websocket", grant: { clientId?: string } = {}): Ticket {
    this.#sweep();
    const ticket = randomBytes(32).toString("hex");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#issued.set(ticket, { kind, expiresAt, ...(grant.clientId !== undefined ? { clientId: grant.clientId } : {}) });
    return { ticket, expiresAt };
  }

  /** The ticket's grant exactly once per valid, unexpired ticket; undefined otherwise. */
  consume(ticket: string): { clientId?: string } | undefined {
    const entry = this.#issued.get(ticket);
    if (!entry) return undefined;
    this.#issued.delete(ticket);
    if (entry.expiresAt <= this.#now()) return undefined;
    return entry.clientId !== undefined ? { clientId: entry.clientId } : {};
  }

  #sweep(): void {
    const now = this.#now();
    for (const [ticket, entry] of this.#issued) if (entry.expiresAt <= now) this.#issued.delete(ticket);
  }
}
