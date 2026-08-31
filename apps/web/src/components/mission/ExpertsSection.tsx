import { selectExpertsSessions } from "@tide/client";
import { PHASE_LABELS } from "../../lib/expertsActions.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import styles from "./MissionControl.module.css";

/** Experts sessions across projects, alongside the thread list. */
export function ExpertsSection({ projectId }: { projectId: string | undefined }) {
  const model = useModel((s) => s.model);
  const sessions = selectExpertsSessions(model, projectId);
  const projects = model.projects;
  const threads = model.threads;
  const selectExpertsSession = useUi((s) => s.selectExpertsSession);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  const targetProjectId = projectId ?? Object.keys(projects)[0];

  return (
    <section className={styles.section} aria-label="Experts">
      <div className={styles.header}>
        <h2 className={styles.heading}>Experts</h2>
        <div className={styles.new}>
          <Button
            disabled={targetProjectId === undefined}
            onClick={() => targetProjectId && setNewExpertsProject(targetProjectId)}
          >
            New experts session
          </Button>
        </div>
      </div>
      {sessions.length === 0 ? (
        <p className={styles.empty}>No experts sessions.</p>
      ) : (
        <ul className={styles.list}>
          {sessions.map((session) => {
            const lead = session.lead.threadId ? threads[session.lead.threadId] : undefined;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => selectExpertsSession(session.id)}
                >
                  <span aria-hidden="true">◆</span>
                  <span className={styles.title}>{session.topic}</span>
                  {lead?.attention === "plan" ? (
                    <Pill tone="accent">needs you</Pill>
                  ) : null}
                  <span className={styles.project}>{projects[session.projectId]?.title ?? "—"}</span>
                  <Pill>{PHASE_LABELS[session.phase]}</Pill>
                  <span className={styles.project}>{session.experts.length} experts</span>
                  <span className={styles.time}>{relativeTime(session.updatedAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
