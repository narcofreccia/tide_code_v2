import type { Message } from "@tide/contracts";
import { Icon, type IconName } from "../ui/Icon.tsx";
import styles from "./NoticeRow.module.css";

type Source = NonNullable<Message["notification"]>["source"];

const ICON: Record<Source, IconName> = {
  delegate: "external",
  "child-question": "inbox",
  pr: "pullRequest",
  restart: "refresh",
  system: "bell",
  schedule: "snooze",
  webhook: "bell",
};

/** A server-authored wake-up (delegate done, child asked, PR changed, restart) — not something the user typed. */
export function NoticeRow({ message }: { message: Message }) {
  const notification = message.notification;
  if (!notification) return null;
  return (
    <li className={styles.notice} data-source={notification.source}>
      <Icon name={ICON[notification.source] ?? ICON.system} size={12} className={`${styles.icon}`} />
      <span className={styles.summary}>{notification.summary}</span>
    </li>
  );
}
