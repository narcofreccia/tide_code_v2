import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useLatestTurnStatus, useSelectedThread } from "../../state/hooks.ts";
import { ConnectionDot } from "../ui/ConnectionDot.tsx";
import { PrBadge } from "../ui/VcsBadges.tsx";
import { useSelectedDiffStats, useVcsStatus } from "../../state/vcs.ts";
import styles from "./StatusBar.module.css";

const LABEL: Record<string, string> = {
  open: "connected",
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  closed: "disconnected",
};

/** `ctx 41% · $0.82` — the glass-box numbers, only when the harness reports them. */
function ThreadStats({ thread }: { thread: Thread }) {
  const context = thread.contextUsage;
  const percent = context && context.window > 0 ? Math.round((context.used / context.window) * 100) : undefined;
  const cost = thread.totalCostUsd;
  if (percent === undefined && cost === undefined) return null;
  return (
    <span className={styles.item}>
      {percent === undefined ? null : `ctx ${percent}%`}
      {percent !== undefined && cost !== undefined ? " · " : ""}
      {cost === undefined ? null : `$${cost.toFixed(2)}`}
    </span>
  );
}

/** `⎇ branch (worktree)` + the selected turn's diff stats + the PR chip. */
function GitStatus({ thread }: { thread: Thread }) {
  // worktree threads carry their branch in the read model; others need git.
  const status = useVcsStatus(thread.worktreePath === undefined ? thread.id : undefined);
  const stats = useSelectedDiffStats(thread.id);
  const branch = thread.branch ?? status.data?.branch;
  const onWorktree = thread.worktreePath !== undefined || status.data?.worktree === true;

  return (
    <>
      {branch ? (
        <span className={styles.item} title={thread.worktreePath ?? status.data?.cwd ?? branch}>
          ⎇ {branch}
          {onWorktree ? " (worktree)" : ""}
        </span>
      ) : null}
      {stats ? (
        <span className={styles.item}>
          <span className={styles.add}>+{stats.additions}</span>
          <span className={styles.del}>−{stats.deletions}</span>
        </span>
      ) : null}
      {thread.pr ? <PrBadge pr={thread.pr} /> : null}
    </>
  );
}

export function StatusBar() {
  const status = useModel((s) => s.status);
  const environmentId = useModel((s) => s.environmentId);
  const lastError = useModel((s) => s.lastError);
  const thread = useSelectedThread();
  const turnStatus = useLatestTurnStatus(thread);

  return (
    <footer className={styles.bar}>
      <span className={styles.item}>
        <ConnectionDot status={status} />
        {LABEL[status] ?? status}
      </span>
      <span className={styles.mono}>{environmentId ?? "no environment"}</span>
      {thread ? <span className={styles.item}>thread: {turnStatus ?? thread.status}</span> : null}
      {thread ? <ThreadStats thread={thread} /> : null}
      {thread ? <GitStatus thread={thread} /> : null}
      {lastError ? <span className={styles.error}>{lastError}</span> : null}
    </footer>
  );
}
