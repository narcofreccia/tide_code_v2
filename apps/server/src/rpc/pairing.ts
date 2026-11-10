import { randomInt, timingSafeEqual } from "node:crypto";
import type { DeviceAccess } from "@tide/contracts";

export const PAIR_CODE_TTL_MS = 5 * 60_000;
export const PAIR_ATTEMPTS_PER_MINUTE = 5;
/**
 * R18: every attempt that arrives through the relay shares one bucket (the relay forwards no
 * client address the server could trust), so that bucket is stricter than a single LAN address.
 */
export const RELAY_PAIR_ATTEMPTS_PER_MINUTE = 3;
/** the bucket key for relayed attempts; never a real socket address */
export const RELAY_BUCKET = "relay";
/** R18: bound on tracked addresses; the oldest entry is evicted past it */
export const MAX_TRACKED_ADDRESSES = 1024;
/** wrong guesses (from any address) after which every outstanding code is burnt */
const MAX_FAILURES_PER_CODE = 20;
const WINDOW_MS = 60_000;

export type PairOutcome = "ok" | "invalid" | "rate-limited";
/** R19: a redeemed code says which level the new device gets */
export type PairRedemption = { outcome: "ok"; access: DeviceAccess } | { outcome: "invalid" } | { outcome: "rate-limited" };

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
 * them). Exchanging one mints a per-device bearer token (clientTokens.ts), so attempts are rate-limited per
 * address and a code that collects too many wrong guesses is burnt.
 */
export class PairingCodes {
  #codes = new Map<string, { expiresAt: number; access: DeviceAccess }>();
  #attempts = new Map<string, number[]>();
  #failures = 0;
  #now: () => number;
  #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? PAIR_CODE_TTL_MS;
  }

  /** R19: the code pairs a device at `access` (default `limited`). */
  issue(options: { access?: DeviceAccess } = {}): { code: string; expiresAt: number; access: DeviceAccess } {
    this.#sweep();
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (this.#codes.has(code));
    const expiresAt = this.#now() + this.#ttlMs;
    const access = options.access ?? "limited";
    this.#codes.set(code, { expiresAt, access });
    return { code, expiresAt, access };
  }

  /**
   * `ok` exactly once per live code; every call counts against the caller's per-minute budget.
   * `address` is the bucket: the socket's remote address, or RELAY_BUCKET for relayed attempts.
   */
  exchange(code: string, address: string): PairOutcome {
    return this.redeem(code, address).outcome;
  }

  /** `exchange` plus the level the code was issued with. */
  redeem(code: string, address: string): PairRedemption {
    const now = this.#now();
    const limit = address === RELAY_BUCKET ? RELAY_PAIR_ATTEMPTS_PER_MINUTE : PAIR_ATTEMPTS_PER_MINUTE;
    const recent = (this.#attempts.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) {
      this.#attempts.set(address, recent);
      return { outcome: "rate-limited" };
    }
    recent.push(now);
    // re-insert so Map order is least-recently-attempted first, then evict past the bound
    this.#attempts.delete(address);
    this.#attempts.set(address, recent);
    this.#sweep();
    while (this.#attempts.size > MAX_TRACKED_ADDRESSES) {
      const oldest = this.#attempts.keys().next().value as string;
      this.#attempts.delete(oldest);
    }
    let match: string | undefined;
    // compare against every live code so the timing does not say which one was close
    for (const live of this.#codes.keys()) if (safeEqual(live, code)) match = live;
    if (match === undefined) {
      if (++this.#failures >= MAX_FAILURES_PER_CODE) {
        this.#codes.clear();
        this.#failures = 0;
      }
      return { outcome: "invalid" };
    }
    const access = this.#codes.get(match)?.access ?? "limited";
    this.#codes.delete(match);
    return { outcome: "ok", access };
  }

  /** addresses currently tracked (tests) */
  get trackedAddresses(): number {
    return this.#attempts.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [code, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(code);
    if (this.#codes.size === 0) this.#failures = 0;
    for (const [address, times] of this.#attempts) if (times.every((t) => now - t >= WINDOW_MS)) this.#attempts.delete(address);
  }
}
