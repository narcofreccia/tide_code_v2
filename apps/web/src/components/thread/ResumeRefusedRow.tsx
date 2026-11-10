import type { Activity } from "@tide/contracts";
import { focusComposer } from "../../lib/composerFocus.ts";
import { armFreshSession, useArmed } from "../../state/freshSession.ts";
import { useModel } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./ActivityRow.module.css";

type NoteActivity = Extract<Activity, { kind: "info" | "error" }>;

/**
 * R19 L5 SEAM: the server marks a refused resume through `payload.code` (see
 * `apps/server/src/provider/sessionNotices.ts`) until `InfoActivity` carries a field of its own.
 */
export function isResumeRefused(activity: NoteActivity): boolean {
  const payload = activity.payload;
  return activity.kind === "error" && typeof payload === "object" && payload !== null && (payload as { code?: unknown }).code === "resume-refused";
}

/**
 * The harness could not reopen its native session, and every later turn would fail the same way.
 * One click arms the same fresh session `/clear` does and hands focus to the composer; nothing is
 * sent or retried until the user sends. The action goes once a fresh session began after this turn.
 */
export function ResumeRefusedRow({ activity }: { activity: NoteActivity }) {
  const { threadId, turnId } = activity;
  const armed = useArmed(threadId);
  const running = useModel((s) => s.model.threads[threadId]?.status === "running");
  const superseded = useModel((s) => {
    const boundary = s.model.threads[threadId]?.sessionBoundaryTurnId;
    if (boundary === undefined || boundary === turnId) return false;
    const after = s.model.turns[boundary]?.requestedAt;
    const mine = s.model.turns[turnId]?.requestedAt;
    return after !== undefined && mine !== undefined && after > mine;
  });

  const start = (): void => {
    armFreshSession(threadId);
    focusComposer();
  };

  return (
    <li className={styles.item}>
      <div className={`${styles.row} ${styles.error}`}>
        <span className={styles.glyph}>✕</span>
        <span className={styles.target} title={activity.text}>
          {activity.text}
        </span>
      </div>
      {superseded ? null : (
        <div className={styles.recovery}>
          <span>A fresh session keeps this thread and its files, but the agent starts without the earlier conversation.</span>
          {armed ? (
            <span className={styles.recoveryArmed}>Your next message starts a fresh session.</span>
          ) : (
            <Button variant="quiet" disabled={running} title={running ? "Wait for the turn to finish" : undefined} onClick={start}>
              Start a fresh session
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
