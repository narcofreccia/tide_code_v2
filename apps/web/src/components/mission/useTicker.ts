import { useEffect, useState } from "react";

/**
 * Re-renders every `everyMs` and returns the current clock — the only motion in
 * Mission Control is the elapsed time of a running turn, so nothing ticks when
 * `everyMs` is 0.
 */
export function useTicker(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs <= 0) return undefined;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** `0:07` / `4:31` / `1:02:09` — a running turn's age, monospaced in the row. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}
