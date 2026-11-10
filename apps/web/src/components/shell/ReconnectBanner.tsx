import { useEffect, useState } from "react";
import { formatElapsed } from "../mission/useTicker.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./ReconnectBanner.module.css";

/** A blip shorter than this never shows a banner. */
export const RECONNECT_BANNER_DELAY_MS = 2000;

/**
 * The calm "Reconnecting…" pill after the app has been connected once: non-blocking, with
 * how long the server has been unreachable and a Retry that skips the backoff. Mounted when
 * the connection drops and unmounted when it is back, so its clock is that drop's.
 */
export function ReconnectBanner({ onRetry }: { onRetry?: (() => void) | undefined }) {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const down = now - since;
  if (down < RECONNECT_BANNER_DELAY_MS) return null;
  return (
    <div className={styles.banner} role="status" aria-label="Connection">
      <span className={styles.dot} aria-hidden="true" />
      <span>Reconnecting…</span>
      <span className={styles.elapsed}>{formatElapsed(down)}</span>
      {onRetry ? (
        <Button variant="quiet" className={styles.retry} onClick={onRetry}>
          Retry now
        </Button>
      ) : null}
    </div>
  );
}

/** The non-blocking line for a refused token after the user chose to look around anyway. */
export function UnauthorizedBanner() {
  return (
    <div className={`${styles.banner} ${styles.bad}`} role="status" aria-label="Connection">
      <span className={styles.dot} aria-hidden="true" />
      <span>The server refused this device's token. Pair again or reload with a valid token.</span>
    </div>
  );
}
