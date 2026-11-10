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

type TurnStart = Extract<InternalCommand, { type: "turn.start" }>;

/**
 * `turn.start` that also records a `session.boundary` for the turn (decider: boundary first, then
 * `turn.started`).
 */
export function startCommand(command: TurnStart, loss: ResumeLoss | undefined): TurnStart {
  if (loss === undefined) return command;
  return { ...command, freshSession: true };
}
