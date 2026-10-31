import type { Message, ProviderKind } from "@tide/contracts";
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
  harness: "play",
};

const ACTOR: Partial<Record<ProviderKind, string>> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi" };

/** A server-authored wake-up (delegate done, child asked, PR changed, restart) — not something the user typed. */
export function NoticeRow({ message, provider }: { message: Message; provider?: ProviderKind }) {
  const notification = message.notification;
  if (!notification) return null;
  return (
    <li className={styles.notice} data-source={notification.source}>
      <Icon name={ICON[notification.source] ?? ICON.system} size={12} className={`${styles.icon}`} />
      {notification.source === "harness" ? (
        <span className={styles.lead}>{`${(provider !== undefined ? ACTOR[provider] : undefined) ?? "The harness"} continued`}</span>
      ) : null}
      <span className={styles.summary}>{notification.summary}</span>
    </li>
  );
}
