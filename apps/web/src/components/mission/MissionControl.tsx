import { selectProjects, selectRepoGroups } from "@tide/client";
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
import { MachinesStrip } from "../fleet/MachinesStrip.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import styles from "./MissionControl.module.css";

/**
 * The landing view, in the order you act on it: Needs you (full width, every
 * waiting card rendered inline so it can be answered here), Running now, Limited,
 * the Projects grid, Snoozed, the harness roster folded to one line, and the
 * machines (environments) with their load. The
 * project scope comes from the top bar's switcher; this view only reflects it.
 * Until the first snapshot lands it shows a skeleton: first-run content is for a server
 * that answered "nothing yet", never for one that has not answered.
 */
export function MissionControl() {
  const model = useModel((s) => s.model);
  const ready = useModel((s) => s.ready);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const projects = selectProjects(model).filter(
    (p) => selectedProjectId === null || p.id === selectedProjectId,
  );
  const groups = selectRepoGroups(model).filter((g) => selectedProjectId === null || g.projects.some((p) => p.id === selectedProjectId));
  const scoped = selectedProjectId === null ? undefined : selectedProjectId;
  const gettingStarted = shouldShowGettingStarted(model);
  const howItWorks = shouldShowHowItWorks(model);

  return (
    <section className={styles.view} aria-label="Mission Control">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.pageTitle}>Mission Control</h1>
          <span className={styles.scope}>
            {scoped === undefined ? "All projects" : (model.projects[scoped]?.title ?? "—")}
          </span>
        </div>
        <div className={styles.headTotals}>
          <ProjectTotals aggregate {...(scoped === undefined ? {} : { projectId: scoped })} />
        </div>
      </header>

      {!ready ? (
        <Skeleton rows={6} label="Loading Mission Control" />
      ) : projects.length === 0 ? (
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
              {groups.map((group, index) => (
                <Fragment key={group.key}>
                  <ProjectCard project={group.lead} />
                  {index === 0 && howItWorks ? <HowTideWorks /> : null}
                </Fragment>
              ))}
            </div>
          </section>
          <SnoozedSection />
          <ProvidersStrip />
        </>
      )}
      <MachinesStrip />
    </section>
  );
}
