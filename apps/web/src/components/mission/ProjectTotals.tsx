import { selectProjects, selectProjectTotals } from "@tide/client";
import { useModel } from "../../state/model.ts";
import styles from "./MissionControl.module.css";

/**
 * Glass-box strip: what each project is spending right now. Context is the max
 * across the project's threads — summing percentages of different windows is
 * meaningless.
 */
export function ProjectTotals({ projectId }: { projectId?: string }) {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model).filter((p) => projectId === undefined || p.id === projectId);
  if (projects.length === 0) return null;

  return (
    <ul className={styles.list} aria-label="Project totals">
      {projects.map((project) => {
        const totals = selectProjectTotals(model, project.id);
        return (
          <li key={project.id} className={styles.totals}>
            <span className={styles.totalsProject}>{project.title}</span>
            <span className={styles.totalsValue}>{totals.running} running</span>
            <span className={styles.totalsValue}>{totals.needsYou} needs you</span>
            <span className={styles.totalsValue}>{totals.threads} threads</span>
            <span className={styles.totalsValue}>${totals.costTodayUsd.toFixed(2)} today</span>
            <span className={styles.totalsValue}>
              {totals.maxContextPercent === undefined ? "ctx —" : `max ctx ${totals.maxContextPercent}%`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
