import type { PullRequest, Thread } from "@tide/contracts";
import { watchPr } from "../../lib/turnActions.ts";
import { Checkbox } from "../ui/Choice.tsx";
import styles from "./PrWatch.module.css";

const CHECKS = {
  success: { glyph: "✔", label: "checks passing" },
  failure: { glyph: "✘", label: "checks failing" },
  pending: { glyph: "…", label: "checks running" },
} as const;

/** Watch toggle plus the CI / comments / conflict state the watcher reacts to. */
export function PrWatch({ thread, pr }: { thread: Thread; pr: PullRequest }) {
  const checks = pr.checks === undefined ? undefined : CHECKS[pr.checks];
  return (
    <span className={styles.watch}>
      <Checkbox
        checked={thread.prWatch !== undefined}
        title="Wake this thread on CI failure, new comments or conflicts"
        onChange={(e) => watchPr(thread.id, e.target.checked)}
      >
        Watch PR
      </Checkbox>
      {checks === undefined ? null : (
        <span className={styles[pr.checks ?? "pending"]} title={checks.label} aria-label={checks.label}>
          {checks.glyph}
        </span>
      )}
      {pr.comments === undefined ? null : (
        <span className={styles.muted} title="comments on the PR" aria-label={`${pr.comments} comments`}>
          💬 {pr.comments}
        </span>
      )}
      {pr.mergeable === false ? (
        <span className={styles.failure} title="The PR has merge conflicts" aria-label="merge conflict">
          ⚠ conflict
        </span>
      ) : null}
    </span>
  );
}
