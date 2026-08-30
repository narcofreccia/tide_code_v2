import type { PullRequest, Thread } from "@tide/contracts";
import styles from "./VcsBadges.module.css";

const PR_GLYPH: Record<PullRequest["state"], string> = { open: "⇡", merged: "✓", closed: "✕" };

/** `⎇` marker: this thread runs on its own worktree. */
export function WorktreeGlyph({ thread }: { thread: Thread }) {
  if (thread.worktreePath === undefined) return null;
  const label = `worktree: ${thread.worktreePath}`;
  return (
    <span className={styles.worktree} title={label} aria-label={label} role="img">
      ⎇
    </span>
  );
}

/** Compact `⇡ open` / `✓ merged` used in the rail and Mission Control rows. */
export function PrGlyph({ pr }: { pr: PullRequest | undefined }) {
  if (!pr) return null;
  const label = `PR #${pr.number} ${pr.state}`;
  return (
    <span className={`${styles.glyph} ${styles[pr.state]}`} title={label} aria-label={label} role="img">
      {PR_GLYPH[pr.state]} {pr.state}
    </span>
  );
}

/** `#123 open` link for the thread header and the status bar. */
export function PrBadge({ pr }: { pr: PullRequest }) {
  return (
    <a
      className={`${styles.badge} ${styles[pr.state]}`}
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={pr.url}
    >
      #{pr.number} {pr.state}
    </a>
  );
}
