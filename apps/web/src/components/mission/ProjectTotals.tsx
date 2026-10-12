import { selectCostRollup, selectProjects, selectProjectTotals, type ProjectTotals as Totals } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { CostSummary } from "./CostSummary.tsx";
import styles from "./MissionControl.module.css";

/** Folds per-project counts into one; context is the max, never a sum. Cost is recomputed, not folded. */
function foldCounts(parts: Totals[]): Pick<Totals, "threads" | "running" | "needsYou" | "maxContextPercent"> {
  let threads = 0;
  let running = 0;
  let needsYou = 0;
  let maxContextPercent: number | undefined;
  for (const part of parts) {
    threads += part.threads;
    running += part.running;
    needsYou += part.needsYou;
    if (part.maxContextPercent !== undefined) {
      maxContextPercent = Math.max(maxContextPercent ?? 0, part.maxContextPercent);
    }
  }
  return { threads, running, needsYou, ...(maxContextPercent === undefined ? {} : { maxContextPercent }) };
}

function Values({
  counts,
  cost,
}: {
  counts: Pick<Totals, "threads" | "running" | "needsYou" | "maxContextPercent">;
  cost: { todayUsd: number; lifetimeUsd: number; byProvider: Totals["costByProvider"] };
}) {
  return (
    <>
      <span className={styles.totalsValue}>{counts.running} running</span>
      <span className={styles.totalsValue}>{counts.needsYou} needs you</span>
      <span className={styles.totalsValue}>{counts.threads} threads</span>
      <span className={styles.totalsValue}>
        {counts.maxContextPercent === undefined ? "ctx —" : `max ctx ${counts.maxContextPercent}%`}
      </span>
      <CostSummary {...cost} />
    </>
  );
}

/**
 * Glass-box strip: what the visible projects are spending. `aggregate` folds
 * them into the single line the Mission Control header carries; without it
 * each project keeps its own row. Cost is per settled turn (today = settled
 * today), split by the harness that ran it.
 */
export function ProjectTotals({ projectId, aggregate }: { projectId?: string; aggregate?: boolean }) {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model).filter((p) => projectId === undefined || p.id === projectId);
  if (projects.length === 0) return null;
  const totals = projects.map((p) => selectProjectTotals(model, p.id));

  if (aggregate === true) {
    const cost = selectCostRollup(model, projects.map((p) => p.id));
    return (
      <div className={styles.totals} aria-label="Project totals">
        <Values counts={foldCounts(totals)} cost={cost} />
      </div>
    );
  }

  return (
    <ul className={styles.totalsList} aria-label="Project totals">
      {projects.map((project, i) => {
        const t = totals[i] as Totals;
        return (
          <li key={project.id} className={styles.totals}>
            <span className={styles.totalsProject}>{project.title}</span>
            <Values
              counts={t}
              cost={{ todayUsd: t.costTodayUsd, lifetimeUsd: t.costLifetimeUsd, byProvider: t.costByProvider }}
            />
          </li>
        );
      })}
    </ul>
  );
}
