import type { Thread } from "@tide/contracts";
import { Composer } from "./Composer.tsx";
import { PlanProgress } from "./PlanProgress.tsx";
import { Stream } from "./Stream.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import styles from "./ThreadView.module.css";

export function ThreadView({ thread }: { thread: Thread }) {
  return (
    <section className={styles.column} aria-label="Thread">
      <ThreadHeader thread={thread} />
      {thread.planProgress ? <PlanProgress progress={thread.planProgress} /> : null}
      <Stream threadId={thread.id} provider={thread.provider} />
      <Composer thread={thread} />
    </section>
  );
}
