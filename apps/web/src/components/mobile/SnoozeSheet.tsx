import { snoozeThreads } from "../../lib/inboxActions.ts";
import { tomorrowMorning } from "../../lib/turnActions.ts";
import { BottomSheet } from "./BottomSheet.tsx";
import styles from "./SnoozeSheet.module.css";

const HOUR_MS = 3_600_000;

/** Left-swipe target: snooze one thread for an hour or until tomorrow 09:00. */
export function SnoozeSheet({ threadId, title, onClose }: { threadId: string; title: string; onClose: () => void }) {
  const pick = (until: number): void => {
    onClose();
    void snoozeThreads([threadId], until);
  };
  return (
    <BottomSheet title={`Snooze “${title}”`} onClose={onClose}>
      <button type="button" className={styles.option} onClick={() => pick(Date.now() + HOUR_MS)}>
        In 1 hour
      </button>
      <button type="button" className={styles.option} onClick={() => pick(tomorrowMorning())}>
        Tomorrow 09:00
      </button>
    </BottomSheet>
  );
}
