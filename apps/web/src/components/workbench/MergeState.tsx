import type { Thread } from "@tide/contracts";
import { mergeTarget } from "../../lib/merge.ts";
import { mergeThread } from "../../lib/threadActions.ts";
import { openFileTab } from "../../state/workbench.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./MergeAction.module.css";

/**
 * What the last `thread.merge` is doing: a spinner while it runs; the
 * conflicted files (each opens in the editor) with a retry; the error with a
 * retry; a quiet `✓ merged` once it landed. Renders nothing before any merge.
 */
export function MergeState({ thread, running }: { thread: Thread; running: boolean }) {
  const merge = thread.merge;
  if (!merge) return null;
  const retry = (
    <Button
      variant="ghost"
      disabled={running}
      title={running ? "Wait for the turn to finish" : `Merge ${mergeTarget(thread)} again`}
      onClick={() => void mergeThread(thread.id, { strategy: merge.strategy })}
    >
      Retry merge
    </Button>
  );

  if (merge.status === "merging") {
    return (
      <div className={styles.state} data-status="merging" role="status">
        <div className={styles.stateHead}>
          <span className={styles.spinner} aria-hidden="true" />
          <span>Merging {mergeTarget(thread)} ({merge.strategy})…</span>
        </div>
      </div>
    );
  }

  if (merge.status === "merged") {
    return (
      <div className={styles.state} data-status="merged" role="status">
        <div className={styles.stateHead}>
          <span className={styles.merged}>✓ merged</span>
          <span className={styles.stateHint}>
            {mergeTarget(thread)}
            {merge.sha ? ` · ${merge.sha.slice(0, 7)}` : ""}
          </span>
        </div>
      </div>
    );
  }

  if (merge.status === "conflicted") {
    const files = merge.files ?? [];
    return (
      <section className={styles.state} data-status="conflicted" aria-label="Merge conflicts">
        <div className={styles.stateHead}>
          <span className={`${styles.stateTitle} ${styles.conflicted}`}>
            ⚠ Merge conflicted{files.length > 0 ? ` in ${files.length} file${files.length === 1 ? "" : "s"}` : ""}
          </span>
          {retry}
        </div>
        {files.length > 0 ? (
          <ul className={styles.files}>
            {files.map((path) => (
              <li key={path} className={styles.file}>
                <Button variant="link" title={`Open ${path}`} onClick={() => openFileTab(thread.id, path)}>
                  {path}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className={styles.stateHint}>
          Resolve the conflicts in the worktree — here in the editor, or in the terminal (⌘`) — or ask the agent,
          then retry.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.state} data-status="error" aria-label="Merge error">
      <div className={styles.stateHead}>
        <span className={`${styles.stateTitle} ${styles.error}`}>✕ Merge failed</span>
        {retry}
      </div>
      {merge.error ? <p className={styles.message}>{merge.error}</p> : null}
    </section>
  );
}
