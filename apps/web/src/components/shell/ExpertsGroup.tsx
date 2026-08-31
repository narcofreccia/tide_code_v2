import { selectExpertsSessions } from "@tide/client";
import type { ExpertsSession, Thread } from "@tide/contracts";
import { PHASE_LABELS } from "../../lib/expertsActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Pill } from "../ui/Pill.tsx";
import styles from "./ProjectTree.module.css";

/** The session's own threads: the lead first, then the panel in roster order. */
export function sessionThreadIds(session: ExpertsSession): string[] {
  const ids: string[] = [];
  if (session.lead.threadId) ids.push(session.lead.threadId);
  for (const expert of session.experts) if (expert.threadId) ids.push(expert.threadId);
  return ids;
}

/** The lead is what needs the user: it is where the synthesis plan lands. */
function needsYou(session: ExpertsSession, threads: Map<string, Thread>): boolean {
  const lead = session.lead.threadId ? threads.get(session.lead.threadId) : undefined;
  return lead?.attention === "plan";
}

/**
 * The project's Experts sessions, above its loose threads. Expert and lead threads
 * hang off their session instead of crowding the project's top level.
 */
export function ExpertsGroup({
  projectId,
  threads,
  renderThread,
}: {
  projectId: string;
  threads: Thread[];
  renderThread: (thread: Thread) => React.ReactNode;
}) {
  const model = useModel((s) => s.model);
  const sessions = selectExpertsSessions(model, projectId);
  const selectedExpertsSessionId = useUi((s) => s.selectedExpertsSessionId);
  const view = useUi((s) => s.view);
  const selectExpertsSession = useUi((s) => s.selectExpertsSession);
  if (sessions.length === 0) return null;
  const byId = new Map(threads.map((t) => [t.id, t]));

  return (
    <div className={styles.experts}>
      <span className={styles.groupHeading}>Experts</span>
      <ul className={styles.threads}>
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={`${styles.thread} ${
                view === "experts" && session.id === selectedExpertsSessionId ? styles.active : ""
              }`}
              onClick={() => selectExpertsSession(session.id)}
            >
              <span className={styles.roleGlyph} title="experts session" aria-hidden="true">
                ◆
              </span>
              <span className={styles.threadTitle} title={session.topic}>
                {session.topic}
              </span>
              {needsYou(session, byId) ? (
                <span className={styles.needsYou} title="needs you: plan ready" aria-label="needs you">
                  ◐
                </span>
              ) : null}
              <Pill>{PHASE_LABELS[session.phase]}</Pill>
              <span className={styles.provider}>{session.experts.length} experts</span>
            </button>
            <ul className={styles.threads}>
              {sessionThreadIds(session)
                .map((id) => byId.get(id))
                .filter((t): t is Thread => t !== undefined)
                .map((t) => renderThread(t))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
