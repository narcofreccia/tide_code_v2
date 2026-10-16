import { selectProjects } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { InboxColumn } from "./InboxColumn.tsx";
import { LimitedSection, SnoozedSection } from "./LimitedSection.tsx";
import { Fragment } from "react";
import { MissionEmpty, shouldShowGettingStarted } from "./MissionEmpty.tsx";
import { HowTideWorks, shouldShowHowItWorks } from "../shell/HowTideWorks.tsx";
import { NowStrip } from "./NowStrip.tsx";
import { ProjectCard } from "./ProjectCard.tsx";
import { ProjectTotals } from "./ProjectTotals.tsx";
import { ProvidersStrip } from "./ProvidersStrip.tsx";
import styles from "./MissionControl.module.css";

/**
 * The landing view, in the order you act on it: Needs you (full width, every
 * waiting card rendered inline so it can be answered here), Running now, Limited,
 * the Projects grid, Snoozed, and the harness roster folded to one line. The
 * project scope comes from the top bar's switcher; this view only reflects it.
 */
export function MissionControl() {
  const model = useModel((s) => s.model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const projects = selectProjects(model).filter(
    (p) => selectedProjectId === null || p.id === selectedProjectId,
  );
  const scoped = selectedProjectId === null ? undefined : selectedProjectId;
  const gettingStarted = shouldShowGettingStarted(model);
  const howItWorks = shouldShowHowItWorks(model);

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
          {gettingStarted ? <MissionEmpty /> : null}
          <InboxColumn {...(scoped === undefined ? {} : { projectId: scoped })} />
          <NowStrip {...(scoped === undefined ? {} : { projectId: scoped })} />
          <LimitedSection />
          <section className={styles.section} aria-label="Projects">
            <h2 className={styles.label}>Projects</h2>
            <div className={styles.projectGrid}>
              {projects.map((project, index) => (
                <Fragment key={project.id}>
                  <ProjectCard project={project} />
                  {index === 0 && howItWorks ? <HowTideWorks /> : null}
                </Fragment>
              ))}
            </div>
          </section>
          <SnoozedSection />
          <ProvidersStrip />
        </>
      )}
    </section>
  );
}
