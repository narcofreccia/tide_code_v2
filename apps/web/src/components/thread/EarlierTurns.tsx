import { useRef } from "react";
import type { ThreadWindow } from "@tide/client";
import { Button } from "../ui/Button.tsx";
import styles from "./EarlierTurns.module.css";

/**
 * R24: the first row of a windowed stream — "Show earlier turns (N)" while older turns are
 * not loaded, a retry after a failed fetch. `onShow` gets the row below this one, to keep it
 * in place while the earlier turns land above it.
 */
export function EarlierTurns({ hidden, window, onShow, onRetry }: { hidden: number; window: ThreadWindow; onShow: (below: Element | null) => void; onRetry: (below: Element | null) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const below = (): Element | null => ref.current?.nextElementSibling ?? null;
  if (window.error !== undefined) {
    return (
      <li ref={ref} className={styles.row} role="alert">
        <span className={styles.error}>{`Couldn't load activity: ${window.error}`}</span>
        <Button variant="quiet" onClick={() => onRetry(below())}>
          Retry
        </Button>
      </li>
    );
  }
  if (hidden <= 0) return null;
  return (
    <li ref={ref} className={styles.row}>
      <Button variant="quiet" disabled={window.loadingEarlier} onClick={() => onShow(below())}>
        {window.loadingEarlier ? "Loading earlier turns…" : `Show earlier turns (${hidden})`}
      </Button>
    </li>
  );
}
