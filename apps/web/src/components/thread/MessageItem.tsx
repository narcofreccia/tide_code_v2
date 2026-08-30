import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "@tide/contracts";
import styles from "./MessageItem.module.css";

/** User turns stay plain text; assistant prose renders as markdown. */
export function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <li className={isUser ? styles.user : styles.assistant}>
      <div className={styles.body} data-role={message.role}>
        {isUser ? (
          message.text
        ) : (
          <div className={styles.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        )}
        {message.streaming ? <span className={styles.caret} aria-label="streaming" /> : null}
      </div>
    </li>
  );
}
