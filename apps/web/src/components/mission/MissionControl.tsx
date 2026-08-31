import { compareByAttention } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { NewThreadPopover } from "../shell/NewThreadPopover.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { PrGlyph, WorktreeGlyph } from "../ui/VcsBadges.tsx";
import { ExpertsSection } from "./ExpertsSection.tsx";
import { Inbox } from "./Inbox.tsx";
import { ProjectTotals } from "./ProjectTotals.tsx";
import styles from "./MissionControl.module.css";

/** Landing view: every active thread across projects, needs-you first. */
export function MissionControl() {
  const model = useModel((s) => s.model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectThread = useUi((s) => s.selectThread);

  const threads: Thread[] = Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined)
    .filter((t) => selectedProjectId === null || t.projectId === selectedProjectId)
    // expert / lead / delegate threads live under their session or caller, not here
    .filter((t) => t.role === undefined)
    .sort(compareByAttention);

  const targetProjectId = selectedProjectId ?? Object.keys(model.projects)[0];

  return (
    <section className={styles.view} aria-label="Mission Control">
      <Inbox />

      <ProjectTotals {...(selectedProjectId === null ? {} : { projectId: selectedProjectId })} />

      <ExpertsSection projectId={selectedProjectId ?? undefined} />

      <div className={styles.header}>
        <h2 className={styles.heading}>Threads</h2>
        <div className={styles.new}>
          <NewThreadPopover projectId={targetProjectId} align="end" />
        </div>
      </div>

      {threads.length === 0 ? (
        <p className={styles.empty}>
          No active threads. {targetProjectId ? "Start one above." : "Add a project in the rail first."}
        </p>
      ) : (
        <ul className={styles.list}>
          {threads.map((t) => (
            <li key={t.id}>
              <button type="button" className={styles.row} onClick={() => selectThread(t.id)}>
                <StatusGlyph
                  status={t.status}
                  {...(t.attention ? { attention: t.attention } : {})}
                  {...(t.interrupting === true ? { interrupting: true } : {})}
                />
                <span className={styles.title}>{t.title}</span>
                {t.interrupting === true ? <span className={styles.interrupting}>interrupting…</span> : null}
                <WorktreeGlyph thread={t} />
                <PrGlyph pr={t.pr} />
                <span className={styles.project}>{model.projects[t.projectId]?.title ?? "—"}</span>
                <Pill>{t.provider}</Pill>
                <span className={styles.time}>{relativeTime(t.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
