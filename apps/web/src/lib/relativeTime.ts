/** Compact "now / 5m / 3h / 2d" stamp used in the thread list. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** `in 5m / in 3h / in 2d`, or `now` once the moment has passed — for reset times. */
export function relativeUntil(at: number, now: number = Date.now()): string {
  if (at <= now) return "now";
  const stamp = relativeTime(now, at);
  return stamp === "now" ? "in <1m" : `in ${stamp}`;
}
