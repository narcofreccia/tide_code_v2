import type { RateLimit } from "@tide/contracts";
import { relativeUntil } from "../../lib/relativeTime.ts";
import styles from "./RateLimitBadge.module.css";

/** Hover text: the harness's own wording first, then the numbers it gave. */
export function rateLimitTitle(limit: RateLimit, now = Date.now()): string {
  const parts: string[] = [];
  if (limit.note) parts.push(limit.note);
  if (limit.remainingPct !== undefined) parts.push(`${Math.round(limit.remainingPct)}% of the window left`);
  if (limit.resetsAt !== undefined) {
    parts.push(`resets ${relativeUntil(limit.resetsAt, now)} (${new Date(limit.resetsAt).toLocaleTimeString()})`);
  }
  if (limit.overage === true) parts.push("running on overage");
  return parts.length > 0 ? parts.join(" · ") : `rate limit: ${limit.status}`;
}

/**
 * The harness's subscription / API rate-limit state, only when it is not `ok`:
 * `⚠ 12% left · resets in 2h` (warning), `⚠ overage used up` (an exhausted overage
 * window the plan absorbs) or `⛔ limited · resets in 2h`.
 */
export function RateLimitBadge({ limit, now }: { limit: RateLimit | undefined; now?: number }) {
  if (!limit || limit.status === "ok") return null;
  const at = now ?? Date.now();
  const limited = limit.status === "limited";
  // an exhausted overage window: the plan still runs, only extra usage is gone
  const overageSpent = !limited && /overage/.test(limit.note ?? "") && (limit.remainingPct ?? 0) <= 0;
  const head = limited
    ? "⛔ limited"
    : overageSpent
      ? "⚠ overage used up"
      : limit.remainingPct === undefined
      ? "⚠ near limit"
      : `⚠ ${Math.round(limit.remainingPct)}% left`;
  const reset = limit.resetsAt === undefined ? "" : ` · resets ${relativeUntil(limit.resetsAt, at)}`;
  return (
    <span
      className={`${styles.badge} ${limited ? styles.limited : styles.warning}`}
      title={rateLimitTitle(limit, at)}
      aria-label={`rate limit ${limit.status}${reset}`}
    >
      {head}
      {reset}
    </span>
  );
}
