import type { LimitWindow, RateLimit } from "@tide/contracts";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "./generated/v2/RateLimitWindow.ts";

/** `usedPercent` at which the gauge turns to `warning` (Codex's own CLI nudges at 90%). */
export const WARNING_USED_PERCENT = 90;

/** Windows up to a day are the short "session" window; anything longer counts as the long one. */
const SESSION_MAX_MINS = 24 * 60;

function windowKind(mins: number | null): LimitWindow | undefined {
  if (mins === null || mins <= 0) return undefined;
  return mins <= SESSION_MAX_MINS ? "session" : "weekly";
}

function span(mins: number | null): string {
  if (!mins) return "";
  return ` (${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`} window)`;
}

/**
 * `RateLimitSnapshot` (sent by `account/rateLimits/updated` and returned by
 * `account/rateLimits/read`) -> one `RateLimit` per window, the tighter one last: a
 * consumer that keeps only the latest report still sees the binding window. A reached
 * limit (`rateLimitReachedType`, `spendControlReached`) is put on that last report. Codex
 * reports `resetsAt` in epoch seconds (a recorded rollout: `resets_at: 1794660275`); Tide's
 * `RateLimit` is epoch ms.
 */
export function rateLimitsFromSnapshot(snapshot: RateLimitSnapshot | null | undefined, now: number): RateLimit[] {
  if (!snapshot) return [];
  const windows = [snapshot.primary, snapshot.secondary].filter((window): window is RateLimitWindow => window !== null && window !== undefined && typeof window.usedPercent === "number");
  const reachedFlag = Boolean(snapshot.rateLimitReachedType) || snapshot.spendControlReached === true;
  if (windows.length === 0 && !reachedFlag) return [];
  const label = snapshot.limitName ?? snapshot.limitId ?? "codex";
  const reachedNote = snapshot.rateLimitReachedType ? `${label}: ${snapshot.rateLimitReachedType.replaceAll("_", " ")}` : undefined;
  if (windows.length === 0) return [{ status: "limited", ...(reachedNote ? { note: reachedNote } : {}), at: now }];

  // stable sort: on a tie the primary window stays first, so the secondary is the one reported last
  const ordered = [...windows].sort((a, b) => a.usedPercent - b.usedPercent);
  return ordered.map((window, index) => {
    const binding = index === ordered.length - 1;
    const used = window.usedPercent;
    const reached = used >= 100 || (binding && reachedFlag);
    const status = reached ? "limited" : used >= WARNING_USED_PERCENT ? "warning" : "ok";
    const kind = windowKind(window.windowDurationMins);
    return {
      status,
      remainingPct: Math.max(0, Math.min(100, Math.round(100 - used))),
      ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt * 1000 } : {}),
      note: binding && reachedNote ? reachedNote : `${label} ${Math.round(used)}% used${span(window.windowDurationMins)}`,
      ...(kind ? { window: kind } : {}),
      ...(window.windowDurationMins ? { windowMins: window.windowDurationMins } : {}),
      at: now,
    };
  });
}
