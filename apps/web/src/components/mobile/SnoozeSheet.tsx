import { snoozeThreads } from "../../lib/inboxActions.ts";
import { resolveSnoozeOptions } from "../../lib/snooze.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { BottomSheet } from "./BottomSheet.tsx";
import styles from "./SnoozeSheet.module.css";

/** Left-swipe target: snooze one thread for one of the options set in Settings › Inbox. */
export function SnoozeSheet({ threadId, title, onClose }: { threadId: string; title: string; onClose: () => void }) {
  const options = useServerSettings((s) => s.settings.inbox.snoozeOptions);
  const pick = (until: number): void => {
    onClose();
    void snoozeThreads([threadId], until);
  };
  return (
    <BottomSheet title={`Snooze “${title}”`} onClose={onClose}>
      {resolveSnoozeOptions(options).map((o) => (
        <button key={o.label} type="button" className={styles.option} onClick={() => pick(o.until())}>
          {o.label}
        </button>
      ))}
    </BottomSheet>
  );
}
