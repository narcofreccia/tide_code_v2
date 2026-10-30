import { selectCostRollup, selectProjects, selectProjectTotals, type ProjectTotals as Totals } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { formatUsd } from "../../lib/glassBox.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { Pill } from "../ui/Pill.tsx";
import { CostSummary } from "./CostSummary.tsx";
import styles from "./MissionControl.module.css";
import { plural } from "../../lib/format.ts";

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
  pills = false,
}: {
  counts: Pick<Totals, "threads" | "running" | "needsYou" | "maxContextPercent">;
  cost: { todayUsd: number; lifetimeUsd: number; byProvider: Totals["costByProvider"] };
  /** the Mission Control header: every figure as a muted meta pill, cost split in the tooltip */
  pills?: boolean;
}) {
  const ctx = counts.maxContextPercent === undefined ? "ctx —" : `max ctx ${counts.maxContextPercent}%`;
  if (pills) {
    const split = cost.byProvider
      .map((row) => `${PROVIDER_LABELS[row.provider]} ${formatUsd(row.lifetimeUsd)}`)
      .join(" · ");
    return (
      <>
        <Pill tone={counts.running > 0 ? "running" : "muted"}>{counts.running} running</Pill>
        <Pill tone={counts.needsYou > 0 ? "needs" : "muted"}>{counts.needsYou} needs you</Pill>
        <Pill>{plural(counts.threads, "thread")}</Pill>
        <Pill>{ctx}</Pill>
        <span title="Turns that settled today (local time)">
          <Pill>{formatUsd(cost.todayUsd)} today</Pill>
        </span>
        <span title={`Every turn this scope has ever run, archived threads included${split ? `. ${split}` : ""}`}>
          <Pill>{formatUsd(cost.lifetimeUsd)} lifetime</Pill>
        </span>
      </>
    );
  }
  return (
    <>
      <span className={styles.totalsValue}>{counts.running} running</span>
      <span className={styles.totalsValue}>{counts.needsYou} needs you</span>
      <span className={styles.totalsValue}>{plural(counts.threads, "thread")}</span>
      <span className={styles.totalsValue}>{ctx}</span>
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
      <div className={styles.headPills} aria-label="Project totals">
        <Values counts={foldCounts(totals)} cost={cost} pills />
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
