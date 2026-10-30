import { selectExpertsSessions } from "@tide/client";
import { PHASE_LABELS } from "../../lib/expertsActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import styles from "./MissionControl.module.css";
import { plural } from "../../lib/format.ts";

/** The project's live Experts sessions, listed under its card; nothing when there are none. */
export function ProjectExperts({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const model = useModel((s) => s.model);
  const selectExpertsSession = useUi((s) => s.selectExpertsSession);
  const sessions = selectExpertsSessions(model, projectId);
  // no blurb when empty: the strip and the card footer carry Experts, the Experts page explains it
  if (sessions.length === 0) return null;

  return (
    <div className={styles.experts} aria-label={`Experts — ${projectTitle}`}>
      <h4 className={`${styles.label} ${styles.cardLabel}`}>Experts</h4>
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
                <span className={styles.rowGlyph}>
                  <Icon name="experts" size={12} />
                </span>
                <span className={styles.rowTitle}>{session.topic}</span>
                {lead?.attention === "plan" ? <Pill tone="needs">needs you</Pill> : null}
                <Pill>{PHASE_LABELS[session.phase]}</Pill>
                <span className={styles.rowMeta}>{plural(session.experts.length, "expert")}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
