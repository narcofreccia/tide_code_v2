import { prReadiness } from "@tide/client";
import { relativeTime } from "../../lib/relativeTime.ts";
import { environmentName } from "../../state/environments.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Pill } from "../ui/Pill.tsx";
import { READINESS_TONE, checksText, reviewText } from "./prFilters.ts";
import type { PrEntry } from "./prData.ts";
import styles from "./Prs.module.css";

/**
 * One PR: readiness · `#n title` · repo · author · head → base · checks · review ·
 * +/- · thread · environment · age. The row opens the detail pane; the thread tag
 * opens the thread.
 */
export function PrRow({
  entry,
  selected,
  showEnv,
  onOpen,
  now,
}: {
  entry: PrEntry;
  selected: boolean;
  showEnv: boolean;
  onOpen: () => void;
  now?: number;
}) {
  const { pr } = entry;
  const readiness = prReadiness(pr);
  const thread = useModel((s) => (entry.threadId ? s.model.threads[entry.threadId] : undefined));
  const selectThread = useUi((s) => s.selectThread);
  const checks = checksText(pr);
  const review = reviewText(pr);
  const branch = pr.head ? `${pr.head} → ${pr.base ?? "?"}` : "";

  return (
    <li className={`${styles.item} ${selected ? styles.selected : ""}`}>
      <button
        type="button"
        className={styles.row}
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        aria-label={`PR #${pr.number} ${pr.title ?? ""}`.trim()}
      >
        <span className={styles.ready} title={readiness.reasons.join(" · ")}>
          <Pill tone={READINESS_TONE[readiness.label]}>{readiness.label}</Pill>
        </span>
        <span className={styles.titleCell}>
          <span className={styles.number}>#{pr.number}</span> <span className={styles.title}>{pr.title ?? pr.url}</span>
        </span>
        <span className={styles.meta}>
          {pr.repo ? <span className={styles.repo}>{pr.repo}</span> : null}
          {pr.author ? <span>@{pr.author}</span> : null}
          {branch ? (
            <span className={styles.branch} title={branch}>
              {branch}
            </span>
          ) : null}
        </span>
        <span className={styles.checks}>
          {checks ? <span className={checks.includes("✘") ? styles.fail : styles.pass}>{checks}</span> : null}
          {review ? <span className={styles.review}>{review}</span> : null}
        </span>
        <span className={styles.stats}>
          {pr.additions === undefined && pr.deletions === undefined ? null : (
            <>
              <span className={styles.add}>+{pr.additions ?? 0}</span> <span className={styles.del}>−{pr.deletions ?? 0}</span>
            </>
          )}
        </span>
        <span className={styles.age}>{relativeTime(pr.updatedAt, now)}</span>
      </button>
      <span className={styles.tags}>
        {thread ? (
          <button
            type="button"
            className={styles.threadTag}
            title={`Open thread: ${thread.title}`}
            onClick={() => selectThread(thread.id)}
          >
            ⌁ {thread.title}
          </button>
        ) : null}
        {showEnv ? <Pill>{environmentName(entry.envId)}</Pill> : null}
      </span>
    </li>
  );
}
