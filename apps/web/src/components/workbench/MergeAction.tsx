import { useState } from "react";
import type { MergeStrategy, Thread } from "@tide/contracts";
import { MERGE_STRATEGIES, mergeBlockedReason, mergeTarget } from "../../lib/merge.ts";
import { mergeThread } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox, Radio } from "../ui/Choice.tsx";
import { Popover } from "../ui/Popover.tsx";
import styles from "./MergeAction.module.css";

/**
 * `Merge ▾` — lands the thread's branch on its base (locally, or by merging its
 * PR). Disabled, with the reason on hover, while it cannot run.
 */
export function MergeAction({ thread, running }: { thread: Thread; running: boolean }) {
  const [strategy, setStrategy] = useState<MergeStrategy>(thread.merge?.strategy ?? "squash");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const blocked = mergeBlockedReason(thread, running);
  return (
    <Popover
      label="Merge ▾"
      title={blocked ?? `Merge ${mergeTarget(thread)}`}
      variant="quiet"
      disabled={blocked !== undefined}
      align="end"
    >
      {(close) => (
        <div className={styles.panel} aria-label="Merge options">
          <p className={styles.target}>{mergeTarget(thread)}</p>
          <div role="radiogroup" aria-label="Merge strategy" className={styles.strategies}>
            {MERGE_STRATEGIES.map((option) => (
              <Radio
                key={option.value}
                name={`merge-${thread.id}`}
                checked={strategy === option.value}
                onChange={() => setStrategy(option.value)}
              >
                {option.label} <span className={styles.hint}>— {option.description}</span>
              </Radio>
            ))}
          </div>
          <Checkbox checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)}>
            Delete branch after merge
          </Checkbox>
          <div className={styles.row}>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                close();
                void mergeThread(thread.id, { strategy, deleteBranch });
              }}
            >
              Merge
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
