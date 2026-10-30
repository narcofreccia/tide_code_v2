import { useEffect, useRef, useState } from "react";
import type { Thread } from "@tide/contracts";
import { settleThreads } from "../../lib/inboxActions.ts";
import { unsettleThread } from "../../lib/threadActions.ts";
import { useSwipeRow } from "../../lib/swipe.ts";
import { RailThreadRow } from "../shell/RailThreadRow.tsx";
import { SnoozeSheet } from "./SnoozeSheet.tsx";
import styles from "./SwipeRow.module.css";


/**
 * A phone inbox row: swipe right to settle (unsettle when already settled), left for
 * the snooze sheet. The row itself is the rail's own `RailThreadRow`, untouched.
 */
export function SwipeRow({ thread }: { thread: Thread }) {
  const [snoozing, setSnoozing] = useState(false);
  const settled = thread.settledAt !== undefined;
  const swipe = useSwipeRow(
    () => setSnoozing(true),
    () => (settled ? unsettleThread(thread.id) : void settleThreads([thread.id])),
  );
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    surface.current?.style.setProperty("--dx", `${swipe.dx}px`);
  }, [swipe.dx]);

  const label = swipe.reveal === "right" ? (settled ? "Unsettle" : "Settle") : swipe.reveal === "left" ? "Snooze" : "";
  return (
    <li className={styles.item}>
      <div
        className={`${styles.under} ${swipe.reveal === "right" ? styles.right : swipe.reveal === "left" ? styles.left : ""} ${swipe.armed ? styles.armed : ""}`}
        aria-hidden="true"
      >
        {label}
      </div>
      <div
        ref={surface}
        className={`${styles.surface} ${swipe.dragging ? styles.dragging : ""}`}
        data-swipe-row={thread.id}
        {...swipe.handlers}
      >
        <ul className={styles.rows}>
          <RailThreadRow thread={thread} siblings={[]} />
        </ul>
      </div>
      {snoozing ? <SnoozeSheet threadId={thread.id} title={thread.title} onClose={() => setSnoozing(false)} /> : null}
    </li>
  );
}

