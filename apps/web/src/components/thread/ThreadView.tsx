import type { Thread } from "@tide/contracts";
import { sendTurn } from "../../lib/threadActions.ts";
import { Composer } from "./Composer.tsx";
import { Stream } from "./Stream.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import styles from "./ThreadView.module.css";

export function ThreadView({ thread }: { thread: Thread }) {
  return (
    <section className={styles.column} aria-label="Thread">
      <ThreadHeader thread={thread} />
      <Stream threadId={thread.id} />
      <Composer onSend={(text) => sendTurn(thread.id, text)} />
    </section>
  );
}
