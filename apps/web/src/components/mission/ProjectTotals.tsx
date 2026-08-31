import { selectProjects, selectProjectTotals, type ProjectTotals as Totals } from "@tide/client";
import { useModel } from "../../state/model.ts";
import styles from "./MissionControl.module.css";

/** Folds per-project totals into one; context is the max, never a sum. */
function fold(parts: Totals[]): Totals {
  const total: Totals = { threads: 0, running: 0, needsYou: 0, costTodayUsd: 0 };
  let maxContextPercent: number | undefined;
  for (const part of parts) {
    total.threads += part.threads;
    total.running += part.running;
    total.needsYou += part.needsYou;
    total.costTodayUsd += part.costTodayUsd;
    if (part.maxContextPercent !== undefined) {
      maxContextPercent = Math.max(maxContextPercent ?? 0, part.maxContextPercent);
    }
  }
  return maxContextPercent === undefined ? total : { ...total, maxContextPercent };
}

function Values({ totals }: { totals: Totals }) {
  return (
    <>
      <span className={styles.totalsValue}>{totals.running} running</span>
      <span className={styles.totalsValue}>{totals.needsYou} needs you</span>
      <span className={styles.totalsValue}>{totals.threads} threads</span>
      <span className={styles.totalsValue}>${totals.costTodayUsd.toFixed(2)} today</span>
      <span className={styles.totalsValue}>
        {totals.maxContextPercent === undefined ? "ctx —" : `max ctx ${totals.maxContextPercent}%`}
      </span>
    </>
  );
}

/**
 * Glass-box strip: what the visible projects are spending right now. `aggregate`
 * folds them into the single line the Mission Control header carries; without it
 * each project keeps its own row. Context is the max across threads — summing
 * percentages of different windows is meaningless.
 */
export function ProjectTotals({ projectId, aggregate }: { projectId?: string; aggregate?: boolean }) {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model).filter((p) => projectId === undefined || p.id === projectId);
  if (projects.length === 0) return null;
  const totals = projects.map((p) => selectProjectTotals(model, p.id));

  if (aggregate === true) {
    return (
      <div className={styles.totals} aria-label="Project totals">
        <Values totals={fold(totals)} />
      </div>
    );
  }

  return (
    <ul className={styles.totalsList} aria-label="Project totals">
      {projects.map((project, i) => (
        <li key={project.id} className={styles.totals}>
          <span className={styles.totalsProject}>{project.title}</span>
          <Values totals={totals[i] as Totals} />
        </li>
      ))}
    </ul>
  );
}
