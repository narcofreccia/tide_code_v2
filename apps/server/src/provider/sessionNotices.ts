import type { Activity, DriverCaps, InternalCommand, ProviderSession } from "@tide/contracts";

/**
 * D1 (R18): a resume that silently became a new native session must show in the thread.
 *
 * When the server asked a driver to resume a native session and the harness started a new one
 * instead (ACP agent without `loadSession` or whose load failed, a pi session file that is gone),
 * the turn that opened it records a `session.boundary` ("New session · <harness>") and one info
 * row saying the earlier context is gone. The driver says so through `resumeFailed` on the session
 * it returns; an instance whose caps declare `resume: false` is treated the same without asking.
 */

/** What the server learned while opening a session that was asked to resume. */
export interface ResumeLoss {
  /** the instance's label ("Claude Code", "Gemini CLI") */
  label: string;
  /** the driver's one-line reason, for the log */
  reason: string;
}

/** undefined when the resume held (or the driver does not say otherwise and the caps allow resume). */
export function resumeLossOf(session: ProviderSession, caps: Partial<DriverCaps> | undefined, label: string): ResumeLoss | undefined {
  const reported = session.resumeFailed;
  if (typeof reported === "string" && reported !== "") return { label, reason: reported };
  if (caps?.resume === false) return { label, reason: `${label} does not resume sessions` };
  return undefined;
}

export function resumeLostText(loss: ResumeLoss): string {
  return `${loss.label} could not resume the previous session; it starts without the earlier context`;
}

export function resumeLostActivity(loss: ResumeLoss, ids: { id: string; threadId: string; turnId: string; at: number }): Activity {
  return { id: ids.id, threadId: ids.threadId, turnId: ids.turnId, kind: "info", text: resumeLostText(loss), createdAt: ids.at, updatedAt: ids.at };
}

/**
 * R19 L5: a resume the harness refused *loudly* (Claude Code "No conversation found…", Codex
 * "no rollout found…", OpenCode 404 SessionNotFoundError). The driver marks the turn's error, thrown
 * from `openSession` or carried by `settled.error`, with the machine code `resume-refused: ` and
 * the harness's own words after it (the drivers' `resume-refused.ts`). The server turns it into
 * one error row and a plain turn error; every later turn would fail the same way, so the row
 * offers "Start a fresh session" (web `ResumeRefusedRow`). Nothing is retried on its own.
 */
export const RESUME_REFUSED = "resume-refused";
const RESUME_REFUSED_PREFIX = `${RESUME_REFUSED}: `;

/** The harness's own words when `error` is a resume refusal, else undefined. */
export function resumeRefusalOf(error: string | undefined): string | undefined {
  if (error === undefined || !error.startsWith(RESUME_REFUSED_PREFIX)) return undefined;
  return error.slice(RESUME_REFUSED_PREFIX.length).trim() || "the session is gone";
}

export function resumeRefusedText(label: string, reason: string): string {
  return `${label} could not reopen its session (${reason})`;
}

/**
 * SEAM (R19 L5): until `InfoActivity` has a field for it (proposed: `code: "resume-refused"`), the
 * row is marked through `payload.code`; the web reads it in `isResumeRefused`. The payload holds
 * the harness's own words, so the expandable details stay honest.
 */
export function resumeRefusedActivity(label: string, reason: string, ids: { id: string; threadId: string; turnId: string; at: number }): Activity {
  return {
    id: ids.id,
    threadId: ids.threadId,
    turnId: ids.turnId,
    kind: "error",
    text: resumeRefusedText(label, reason),
    payload: { code: RESUME_REFUSED, harness: reason },
    createdAt: ids.at,
    updatedAt: ids.at,
  };
}

/** The row and the turn error for a failed turn whose error is a resume refusal; undefined otherwise. */
export function resumeRefusedRow(error: string | undefined, label: string, ids: () => { id: string; threadId: string; turnId: string; at: number }): { activity: Activity; error: string } | undefined {
  const reason = resumeRefusalOf(error);
  if (reason === undefined) return undefined;
  return { activity: resumeRefusedActivity(label, reason, ids()), error: resumeRefusedText(label, reason) };
}

type TurnStart = Extract<InternalCommand, { type: "turn.start" }>;

/**
 * `turn.start` that also records a `session.boundary` for the turn (decider: boundary first, then
 * `turn.started`).
 */
export function startCommand(command: TurnStart, loss: ResumeLoss | undefined): TurnStart {
  if (loss === undefined) return command;
  return { ...command, freshSession: true };
}
