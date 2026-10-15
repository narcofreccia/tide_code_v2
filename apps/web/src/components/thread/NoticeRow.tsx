import type { Message } from "@tide/contracts";
import styles from "./NoticeRow.module.css";

type Source = NonNullable<Message["notification"]>["source"];

const ICON: Record<Source, string> = {
  delegate: "⇢",
  "child-question": "?",
  pr: "⇡",
  restart: "↻",
  system: "ⓘ",
};

/** A server-authored wake-up (delegate done, child asked, PR changed, restart) — not something the user typed. */
export function NoticeRow({ message }: { message: Message }) {
  const notification = message.notification;
  if (!notification) return null;
  return (
    <li className={styles.notice} data-source={notification.source}>
      <span className={styles.icon} aria-hidden="true">
        {ICON[notification.source] ?? ICON.system}
      </span>
      <span className={styles.summary}>{notification.summary}</span>
    </li>
  );
}
