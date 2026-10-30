import { selectExpertsSessions } from "@tide/client";
import type { ExpertsSession, Thread } from "@tide/contracts";
import { PHASE_LABELS } from "../../lib/expertsActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import styles from "./ExpertsGroup.module.css";
import { plural } from "../../lib/format.ts";

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
 * What Experts is, for a project that has never run a session. It sits below the
 * thread list and its "+ thread · + Experts" links, never between project and threads.
 */
export function ExpertsExplainer({ projectId }: { projectId: string }) {
  const hasSessions = useModel((s) => selectExpertsSessions(s.model, projectId).length > 0);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  if (hasSessions) return null;
  return (
    <div className={styles.experts} aria-label="About Experts">
      <span className={styles.groupHeading}>Experts</span>
      <p className={styles.emptyHint}>
        Several agents explore a question, discuss, and propose one plan.{" "}
        <Button variant="link" onClick={() => setNewExpertsProject(projectId)}>
          Start an Experts session
        </Button>
      </p>
    </div>
  );
}

/**
 * Experts sessions with their expert and lead threads hanging off them, instead of
 * crowding the list. The rail passes the sessions whose lead sits in a group;
 * without `sessions` every session of `projectId` is listed.
 */
export function ExpertsGroup({
  projectId,
  sessions: given,
  threads,
  renderThread,
  heading = true,
}: {
  projectId?: string;
  sessions?: ExpertsSession[];
  threads: Thread[];
  renderThread: (thread: Thread) => React.ReactNode;
  heading?: boolean;
}) {
  const model = useModel((s) => s.model);
  const sessions = given ?? (projectId === undefined ? [] : selectExpertsSessions(model, projectId));
  const selectedExpertsSessionId = useUi((s) => s.selectedExpertsSessionId);
  const view = useUi((s) => s.view);
  const selectExpertsSession = useUi((s) => s.selectExpertsSession);
  if (sessions.length === 0) return null;
  const byId = new Map(threads.map((t) => [t.id, t]));

  return (
    <div className={styles.experts}>
      {heading ? <span className={styles.groupHeading}>Experts</span> : null}
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
              <Icon name="experts" size={14} className={styles.roleGlyph ?? ""} />
              <span className={styles.threadTitle} title={session.topic}>
                {session.topic}
              </span>
              {needsYou(session, byId) ? (
                <span className={styles.needsYou} title="needs you: plan ready" aria-label="needs you" role="img" />
              ) : null}
              <Pill>{PHASE_LABELS[session.phase]}</Pill>
              <span className={styles.provider}>{plural(session.experts.length, "expert")}</span>
            </button>
            <ul className={styles.nested}>
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
