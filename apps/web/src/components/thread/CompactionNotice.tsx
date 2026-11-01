import { memo } from "react";
import type { Activity } from "@tide/contracts";
import type { Compaction } from "../../lib/compaction.ts";
import { useTurnSettled } from "./activities/turnSettled.ts";
import { LiveLabel } from "./LiveLabel.tsx";
import styles from "./CompactionNotice.module.css";

/**
 * The harness compacted (or is compacting) the conversation: a muted divider in the
 * turn, so a `/compact` turn — which writes no answer — still says what happened.
 * Shimmers while the compaction runs; static once done or once its turn settled.
 */
export const CompactionNotice = memo(function CompactionNotice({ activity, compaction }: { activity: Activity; compaction: Compaction }) {
  const settled = useTurnSettled(activity.turnId);
  const live = compaction.phase === "running" && !settled;
  const full = activity.kind === "info" ? activity.text : compaction.text;
  return (
    <li className={styles.notice} data-compaction={compaction.phase}>
      <span className={styles.rule} aria-hidden="true" />
      {live ? (
        <LiveLabel text={compaction.text} className={styles.live} />
      ) : (
        <span className={styles.text} title={full}>
          {compaction.text}
        </span>
      )}
      <span className={styles.rule} aria-hidden="true" />
    </li>
  );
});
