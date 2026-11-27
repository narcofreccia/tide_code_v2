import { memo } from "react";
import type { Compaction } from "../../lib/compaction.ts";
import { useTurnSettled } from "./activities/turnSettled.ts";
import { LiveLabel } from "./LiveLabel.tsx";
import styles from "./CompactionNotice.module.css";

/**
 * The harness compacted (or is compacting) the conversation: a muted divider in the
 * turn, so a `/compact` turn — which writes no answer — still says what happened.
 * Shimmers while the compaction runs; static once done or once its turn settled.
 */
export const CompactionNotice = memo(function CompactionNotice({ turnId, title, compaction }: { turnId: string; title: string; compaction: Compaction }) {
  const settled = useTurnSettled(turnId);
  const live = compaction.phase === "running" && !settled;
  return (
    <li className={styles.notice} data-compaction={compaction.phase}>
      <span className={styles.rule} aria-hidden="true" />
      {live ? (
        <LiveLabel text={compaction.text} className={styles.live} />
      ) : (
        <span className={styles.text} title={title}>
          {compaction.text}
        </span>
      )}
      <span className={styles.rule} aria-hidden="true" />
    </li>
  );
});
