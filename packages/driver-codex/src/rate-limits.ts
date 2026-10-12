import type { RateLimit } from "@tide/contracts";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.ts";

/** `usedPercent` at which the gauge turns to `warning` (Codex's own CLI nudges at 90%). */
export const WARNING_USED_PERCENT = 90;

/**
 * `RateLimitSnapshot` (sent by `account/rateLimits/updated` and returned by
 * `account/rateLimits/read`) -> Tide's gauge. The tighter of the primary/secondary windows
 * drives it. Codex reports `resetsAt` in epoch seconds; Tide's `RateLimit` is epoch ms.
 */
export function rateLimitFromSnapshot(snapshot: RateLimitSnapshot | null | undefined, now: number): RateLimit | undefined {
  if (!snapshot) return undefined;
  const windows = [snapshot.primary, snapshot.secondary].filter((window): window is NonNullable<typeof window> => window !== null && window !== undefined && typeof window.usedPercent === "number");
  if (windows.length === 0 && !snapshot.rateLimitReachedType) return undefined;
  const tightest = windows.reduce<(typeof windows)[number] | undefined>((best, window) => (best === undefined || window.usedPercent > best.usedPercent ? window : best), undefined);
  const used = tightest?.usedPercent;
  const reached = Boolean(snapshot.rateLimitReachedType) || snapshot.spendControlReached === true || (used !== undefined && used >= 100);
  const status = reached ? "limited" : used !== undefined && used >= WARNING_USED_PERCENT ? "warning" : "ok";
  const label = snapshot.limitName ?? snapshot.limitId ?? "codex";
  const span = tightest?.windowDurationMins ? ` (${tightest.windowDurationMins >= 60 ? `${Math.round(tightest.windowDurationMins / 60)}h` : `${tightest.windowDurationMins}m`} window)` : "";
  const note = snapshot.rateLimitReachedType ? `${label}: ${snapshot.rateLimitReachedType.replaceAll("_", " ")}` : `${label}${used !== undefined ? ` ${Math.round(used)}% used${span}` : ""}`;
  return {
    status,
    ...(used !== undefined ? { remainingPct: Math.max(0, Math.min(100, Math.round(100 - used))) } : {}),
    ...(typeof tightest?.resetsAt === "number" ? { resetsAt: tightest.resetsAt * 1000 } : {}),
    note,
    at: now,
  };
}
