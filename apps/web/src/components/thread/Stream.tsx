import { selectThreadMessages } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { MessageItem } from "./MessageItem.tsx";
import styles from "./Stream.module.css";

export function Stream({ threadId }: { threadId: string }) {
  const model = useModel((s) => s.model);
  const messages = selectThreadMessages(model, threadId);

  if (messages.length === 0) {
    return <div className={styles.empty}>No messages yet. Send the first prompt below.</div>;
  }
  return (
    <ol className={styles.stream}>
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
    </ol>
  );
}
