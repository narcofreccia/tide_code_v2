import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./RailEmpty.module.css";

/**
 * The rail's empty states: no project yet (one button to the Add project dialog), a project with
 * no threads (one "New thread" action), a search that found nothing.
 */
export function RailEmpty({ kind, projectId }: { kind: "projects" | "threads" | "search"; projectId?: string }) {
  const openNewThread = useUi((s) => s.openNewThread);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);
  if (kind === "search") {
    return (
      <div className={styles.card} role="status">
        <Icon name="search" size={16} />
        <p className={styles.title}>Nothing matches</p>
        <p className={styles.hint}>Titles, projects and harnesses match as you type; message text from two characters.</p>
      </div>
    );
  }
  if (kind === "projects") {
    return (
      <div className={styles.card}>
        <Icon name="folder" size={16} />
        <p className={styles.title}>Add a repository</p>
        <p className={styles.hint}>Threads run on worktrees of it.</p>
        <Button variant="primary" onClick={() => setNewProjectOpen(true)}>
          Add repository
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.card}>
      <p className={styles.title}>No threads yet</p>
      <Button variant="primary" disabled={!projectId} onClick={() => projectId && openNewThread({ projectId })}>
        <Icon name="plus" size={14} /> New thread
      </Button>
    </div>
  );
}
