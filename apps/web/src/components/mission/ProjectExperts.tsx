import { selectExpertsSessions } from "@tide/client";
import { PHASE_LABELS } from "../../lib/expertsActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Pill } from "../ui/Pill.tsx";
import styles from "./MissionControl.module.css";

/** The project's live Experts sessions, listed under its card. */
export function ProjectExperts({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const model = useModel((s) => s.model);
  const selectExpertsSession = useUi((s) => s.selectExpertsSession);
  const sessions = selectExpertsSessions(model, projectId);
  if (sessions.length === 0) return null;

  return (
    <div className={styles.experts} aria-label={`Experts — ${projectTitle}`}>
      <h4 className={styles.label}>Experts</h4>
      <ul className={styles.list}>
        {sessions.map((session) => {
          const lead = session.lead.threadId ? model.threads[session.lead.threadId] : undefined;
          return (
            <li key={session.id}>
              <button
                type="button"
                className={styles.expertsRow}
                onClick={() => selectExpertsSession(session.id)}
              >
                <span aria-hidden="true">◆</span>
                <span className={styles.title}>{session.topic}</span>
                {lead?.attention === "plan" ? <Pill tone="accent">needs you</Pill> : null}
                <Pill>{PHASE_LABELS[session.phase]}</Pill>
                <span className={styles.meta}>{session.experts.length} experts</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
