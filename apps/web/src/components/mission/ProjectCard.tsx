import { selectPrCounts, selectProjectLinks, selectProjectTotals, selectRecentThreads } from "@tide/client";
import type { Project } from "@tide/contracts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { NewThreadPopover } from "../shell/NewThreadPopover.tsx";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { ProjectExperts } from "./ProjectExperts.tsx";
import styles from "./MissionControl.module.css";

/**
 * One repository: what it costs, what is open on it, its three most recent
 * threads, and the two ways to start work. Flat — a hairline box on `--surface`,
 * never a card inside a card.
 */
export function ProjectCard({ project }: { project: Project }) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const selectProject = useUi((s) => s.selectProject);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  const setLinksProject = useUi((s) => s.setLinksProject);
  const totals = selectProjectTotals(model, project.id);
  const prs = selectPrCounts(model, project.id);
  const recent = selectRecentThreads(model, project.id, 3);
  const links = selectProjectLinks(model, project.id);

  return (
    <article className={styles.card} aria-label={`Project ${project.title}`}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{project.title}</h3>
        <span className={styles.path} title={project.rootPath}>
          {project.rootPath}
        </span>
      </div>

      <div className={styles.counts}>
        <span>{totals.threads} threads</span>
        <span>{totals.running} running</span>
        <span>{totals.needsYou} needs you</span>
        {prs.open > 0 ? <Pill>⇡ {prs.open} open</Pill> : null}
        {prs.merged > 0 ? <Pill>✓ {prs.merged} merged</Pill> : null}
        <span>${totals.costTodayUsd.toFixed(2)} today</span>
        <button
          type="button"
          className={styles.link}
          onClick={() => setLinksProject(project.id)}
          title="Linked repositories"
        >
          {links.length === 0 ? "Link a repo" : `Links · ${links.length}`}
        </button>
      </div>

      {recent.length === 0 ? (
        <p className={styles.empty}>No threads yet.</p>
      ) : (
        <ul className={styles.recent}>
          {recent.map((thread) => (
            <li key={thread.id}>
              <button type="button" className={styles.recentRow} onClick={() => selectThread(thread.id)}>
                <StatusGlyph
                  status={thread.status}
                  {...(thread.attention ? { attention: thread.attention } : {})}
                  {...(thread.interrupting === true ? { interrupting: true } : {})}
                />
                <span className={styles.title}>{thread.title}</span>
                {thread.interrupting === true ? (
                  <span className={styles.interrupting}>interrupting…</span>
                ) : null}
                <span className={styles.time}>{relativeTime(thread.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <ProjectExperts projectId={project.id} projectTitle={project.title} />

      <div className={styles.actions}>
        <NewThreadPopover projectId={project.id} />
        <Button onClick={() => setNewExpertsProject(project.id)}>Experts</Button>
        <button
          type="button"
          className={styles.link}
          onClick={() => selectProject(project.id)}
          aria-label={`All threads in ${project.title}`}
        >
          all threads →
        </button>
      </div>
    </article>
  );
}
