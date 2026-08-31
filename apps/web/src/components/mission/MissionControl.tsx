import { selectProjects } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { InboxColumn } from "./InboxColumn.tsx";
import { MissionEmpty } from "./MissionEmpty.tsx";
import { NowStrip } from "./NowStrip.tsx";
import { ProjectCard } from "./ProjectCard.tsx";
import { ProjectTotals } from "./ProjectTotals.tsx";
import { ProvidersStrip } from "./ProvidersStrip.tsx";
import styles from "./MissionControl.module.css";

/**
 * The landing view. Now (what is running) on top, then two columns: the Inbox on
 * the left — every waiting card rendered inline so it can be answered here — and
 * the projects plus the harness roster on the right. The project scope comes from
 * the top bar's switcher; this view only reflects it.
 */
export function MissionControl() {
  const model = useModel((s) => s.model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const projects = selectProjects(model).filter(
    (p) => selectedProjectId === null || p.id === selectedProjectId,
  );
  const scoped = selectedProjectId === null ? undefined : selectedProjectId;

  return (
    <section className={styles.view} aria-label="Mission Control">
      <div className={styles.head}>
        <h1 className={styles.pageTitle}>Mission Control</h1>
        <span className={styles.scope}>
          {scoped === undefined ? "All projects" : (model.projects[scoped]?.title ?? "—")}
        </span>
        <div className={styles.headTotals}>
          <ProjectTotals aggregate {...(scoped === undefined ? {} : { projectId: scoped })} />
        </div>
      </div>

      {projects.length === 0 ? (
        <MissionEmpty />
      ) : (
        <>
          <NowStrip {...(scoped === undefined ? {} : { projectId: scoped })} />
          <div className={styles.columns}>
            <div className={styles.column}>
              <InboxColumn {...(scoped === undefined ? {} : { projectId: scoped })} />
            </div>
            <div className={styles.column}>
              <section className={styles.section} aria-label="Projects">
                <h2 className={styles.label}>Projects</h2>
                {projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </section>
              <ProvidersStrip />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
