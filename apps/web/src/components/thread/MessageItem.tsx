import type { Message } from "@tide/contracts";
import styles from "./MessageItem.module.css";

export function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <li className={isUser ? styles.user : styles.assistant}>
      <div className={styles.body} data-role={message.role}>
        {message.text}
        {message.streaming ? <span className={styles.caret} aria-label="streaming" /> : null}
      </div>
    </li>
  );
}
