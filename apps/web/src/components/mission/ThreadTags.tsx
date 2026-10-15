import type { Thread } from "@tide/contracts";
import { prWatchLabel } from "./prWatch.ts";
import styles from "./Limited.module.css";

/** Small tags on a thread row: delegate role, and the watched-PR pill. */
export function ThreadTags({ thread }: { thread: Thread }) {
  const pr = prWatchLabel(thread);
  return (
    <>
      {thread.delegateRole === undefined ? null : (
        <span className={styles.roleTag} title="Role given by the delegating thread">
          {thread.delegateRole}
        </span>
      )}
      {pr === undefined ? null : (
        <span
          className={`${styles.prPill} ${thread.pr?.checks === "failure" ? styles.bad : ""}`}
          title="Tide is watching this pull request"
        >
          {pr}
          {thread.pr?.mergeable === false ? <span className={styles.conflict}> · conflict</span> : null}
        </span>
      )}
    </>
  );
}
