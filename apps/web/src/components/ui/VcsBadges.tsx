import { isThreadMerged } from "@tide/client";
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

/**
 * Merge-back state for rows: `⟳ merging`, `⚠ conflicted`, `✕ merge failed`, or
 * `✓ merged` when the branch landed without a merged PR saying so already.
 */
export function MergeGlyph({ thread }: { thread: Thread }) {
  const status = thread.merge?.status;
  let glyph: string;
  let text: string;
  let tone: string | undefined;
  if (status === "merging") [glyph, text, tone] = ["⟳", "merging", styles.merging];
  else if (status === "conflicted") [glyph, text, tone] = ["⚠", "conflicted", styles.conflicted];
  else if (status === "error") [glyph, text, tone] = ["✕", "merge failed", styles.closed];
  else if (isThreadMerged(thread) && thread.pr?.state !== "merged") [glyph, text, tone] = ["✓", "merged", styles.merged];
  else return null;
  return (
    <span className={`${styles.glyph} ${tone ?? ""}`} title={text} aria-label={text} role="img">
      {glyph} {text}
    </span>
  );
}
