import type { Thread } from "@tide/contracts";
import { relativeUntil } from "../../lib/relativeTime.ts";
import { resumeThread, setLimitPolicy, snoozeThread } from "../../lib/turnActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Popover } from "../ui/Popover.tsx";
import styles from "./ThreadHeader.module.css";

const HOUR = 3_600_000;

/** `forked from <title>` — selects the source thread. */
export function LineageChip({ thread }: { thread: Thread }) {
  const sourceId = thread.forkedFrom?.threadId;
  const source = useModel((s) => (sourceId === undefined ? undefined : s.model.threads[sourceId]));
  if (sourceId === undefined) return null;
  return (
    <button
      type="button"
      className={styles.lineage}
      title="Open the thread this one was forked from"
      disabled={source === undefined}
      onClick={() => useUi.getState().selectThread(sourceId)}
    >
      forked from {source?.title ?? "a deleted thread"}
    </button>
  );
}

/** Subscription window exhausted: choose what happens next. */
export function LimitedBadge({ thread }: { thread: Thread }) {
  const limited = thread.limited;
  if (!limited) return null;
  const resetsAt = limited.resetsAt;
  const reset = resetsAt === undefined ? "" : ` · resets ${relativeUntil(resetsAt)}`;
  return (
    <Popover
      label={`⛔ Limited${reset}`}
      title={limited.note ?? "The harness hit its usage limit"}
      variant="quiet"
      align="end"
    >
      {(close) => {
        const act = (run: () => void) => () => {
          close();
          run();
        };
        return (
          <div className={styles.menu}>
            <Button variant="quiet" onClick={act(() => resumeThread(thread.id, true))}>
              Resume now
            </Button>
            <Button
              variant="quiet"
              aria-pressed={limited.resume === "reset"}
              onClick={act(() => setLimitPolicy(thread.id, "reset"))}
            >
              {limited.resume === "reset" ? "✓ " : ""}Resume at reset
            </Button>
            <Button
              variant="quiet"
              aria-pressed={limited.resume === "manual"}
              onClick={act(() => setLimitPolicy(thread.id, "manual"))}
            >
              {limited.resume === "manual" ? "✓ " : ""}Wait for me
            </Button>
            <Button variant="quiet" onClick={act(() => snoozeThread(thread.id, Date.now() + HOUR))}>
              Snooze 1h
            </Button>
            <Button
              variant="quiet"
              disabled={resetsAt === undefined}
              title={resetsAt === undefined ? "The harness gave no reset time" : undefined}
              onClick={act(() => {
                if (resetsAt !== undefined) snoozeThread(thread.id, resetsAt);
              })}
            >
              Snooze until reset
            </Button>
          </div>
        );
      }}
    </Popover>
  );
}

/** `Rolling back…` while a rollback runs; the error when it failed. */
export function RollbackPill({ thread }: { thread: Thread }) {
  const rollback = thread.rollback;
  if (!rollback || rollback.status === "done") return null;
  if (rollback.status === "rolling") {
    return (
      <Pill tone="accent">
        <span className={styles.spinner} aria-hidden="true" /> Rolling back…
      </Pill>
    );
  }
  return (
    <span className={styles.rollbackError} role="alert" title={rollback.error}>
      Rollback failed{rollback.error ? `: ${rollback.error}` : ""}
    </span>
  );
}
