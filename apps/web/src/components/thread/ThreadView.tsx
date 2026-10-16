import type { Thread } from "@tide/contracts";
import { requestDelete, unarchiveThread } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Composer } from "./Composer.tsx";
import { PlanProgress } from "./PlanProgress.tsx";
import { Stream } from "./Stream.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import styles from "./ThreadView.module.css";

/** An archived thread opens read-only: no composer, one way back. */
function ArchivedBar({ thread }: { thread: Thread }) {
  return (
    <div className={styles.archived} role="status">
      <span>Archived — read-only.</span>
      <Button variant="ghost" onClick={() => unarchiveThread(thread.id)}>
        Restore
      </Button>
      <Button variant="ghost" onClick={() => requestDelete(thread)}>
        Delete…
      </Button>
    </div>
  );
}

export function ThreadView({ thread }: { thread: Thread }) {
  return (
    <section className={styles.column} aria-label="Thread" data-thread-column>
      <ThreadHeader thread={thread} />
      {thread.planProgress ? <PlanProgress progress={thread.planProgress} /> : null}
      <Stream threadId={thread.id} provider={thread.provider} />
      {thread.archivedAt === undefined ? <Composer thread={thread} /> : <ArchivedBar thread={thread} />}
    </section>
  );
}
