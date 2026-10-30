import { randomInt, timingSafeEqual } from "node:crypto";

export const PAIR_CODE_TTL_MS = 5 * 60_000;
export const PAIR_ATTEMPTS_PER_MINUTE = 5;
/** wrong guesses (from any address) after which every outstanding code is burnt */
const MAX_FAILURES_PER_CODE = 20;
const WINDOW_MS = 60_000;

export type PairOutcome = "ok" | "invalid" | "rate-limited";

/** Constant-time string compare (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // still spend the compare so a length mismatch is not a fast path
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * One-time pairing codes: 6 digits, 5 minutes, single use, kept in memory only (a restart forgets
 * them). Exchanging one returns the server's bearer token, so attempts are rate-limited per
 * address and a code that collects too many wrong guesses is burnt.
 */
export class PairingCodes {
  #codes = new Map<string, { expiresAt: number }>();
  #attempts = new Map<string, number[]>();
  #failures = 0;
  #now: () => number;
  #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? PAIR_CODE_TTL_MS;
  }

  issue(): { code: string; expiresAt: number } {
    this.#sweep();
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (this.#codes.has(code));
    const expiresAt = this.#now() + this.#ttlMs;
    this.#codes.set(code, { expiresAt });
    return { code, expiresAt };
  }

  /** `ok` exactly once per live code; every call counts against the caller's per-minute budget. */
  exchange(code: string, address: string): PairOutcome {
    const now = this.#now();
    const recent = (this.#attempts.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= PAIR_ATTEMPTS_PER_MINUTE) {
      this.#attempts.set(address, recent);
      return "rate-limited";
    }
    recent.push(now);
    this.#attempts.set(address, recent);
    this.#sweep();
    let match: string | undefined;
    // compare against every live code so the timing does not say which one was close
    for (const live of this.#codes.keys()) if (safeEqual(live, code)) match = live;
    if (match === undefined) {
      if (++this.#failures >= MAX_FAILURES_PER_CODE) {
        this.#codes.clear();
        this.#failures = 0;
      }
      return "invalid";
    }
    this.#codes.delete(match);
    return "ok";
  }

  #sweep(): void {
    const now = this.#now();
    for (const [code, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(code);
    if (this.#codes.size === 0) this.#failures = 0;
    for (const [address, times] of this.#attempts) if (times.every((t) => now - t >= WINDOW_MS)) this.#attempts.delete(address);
  }
}
