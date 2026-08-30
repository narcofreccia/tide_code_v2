import type { Thread } from "@tide/contracts";
import { useLatestTurnStatus } from "../../state/hooks.ts";
import { archiveThread, createThread } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import styles from "./ThreadHeader.module.css";

export function ThreadHeader({ thread }: { thread: Thread }) {
  const turnStatus = useLatestTurnStatus(thread);
  return (
    <header className={styles.header}>
      <StatusGlyph status={thread.status} />
      <span className={styles.branch}>{thread.branch ?? "no worktree"}</span>
      <Pill>{turnStatus ?? thread.status}</Pill>
      <div className={styles.actions}>
        <Button
          variant="quiet"
          onClick={() => void createThread(thread.projectId, thread.provider, thread.id)}
          title="New child thread"
        >
          + child
        </Button>
        <Button variant="quiet" onClick={() => archiveThread(thread.id)}>
          Archive
        </Button>
      </div>
    </header>
  );
}
