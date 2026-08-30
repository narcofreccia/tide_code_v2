import type { Thread } from "@tide/contracts";
import styles from "./PlanProgress.module.css";

const MARK: Record<string, string> = { pending: "○", in_progress: "◐", completed: "✓" };

/** The harness's own todo list, pinned under the header while a turn reports one. */
export function PlanProgress({ progress }: { progress: NonNullable<Thread["planProgress"]> }) {
  const done = progress.steps.filter((s) => s.status === "completed").length;
  return (
    <section className={styles.progress} aria-label="Plan progress">
      <span className={styles.count}>
        {done}/{progress.steps.length}
      </span>
      <ol className={styles.steps}>
        {progress.steps.map((step, i) => (
          <li key={`${i}-${step.text}`} className={`${styles.step} ${styles[step.status] ?? ""}`}>
            <span className={styles.mark}>{MARK[step.status] ?? "○"}</span>
            {step.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
