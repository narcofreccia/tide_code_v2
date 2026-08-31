import type { ExpertsPhase, ExpertSpec, ProviderKind } from "@tide/contracts";
import { dispatch } from "../state/model.ts";
import { showToast } from "../state/toast.ts";
import { useUi } from "../state/ui.ts";
import { openExpertsTab } from "../state/workbench.ts";

/** The phases the stepper walks, in order; `setup` and `archived` sit outside it. */
export const PHASE_STEPS: ExpertsPhase[] = ["exploring", "discussing", "synthesizing", "ready"];

export const PHASE_LABELS: Record<ExpertsPhase, string> = {
  setup: "Setup",
  exploring: "Exploring",
  discussing: "Discussing",
  synthesizing: "Synthesizing",
  ready: "Ready",
  archived: "Archived",
};

/** The phase "Next phase" advances to, or undefined at the end of the walk. */
export function nextPhase(phase: ExpertsPhase): ExpertsPhase | undefined {
  if (phase === "setup") return "exploring";
  const at = PHASE_STEPS.indexOf(phase);
  if (at === -1 || at === PHASE_STEPS.length - 1) return undefined;
  return PHASE_STEPS[at + 1];
}

export interface CreateExpertsInput {
  projectId: string;
  topic: string;
  experts: ExpertSpec[];
  lead: { provider: ProviderKind; model?: string };
}

/**
 * Creates the session, starts it, and puts the board on screen. Start is a second
 * command so a create that succeeds is never lost to a failing spawn.
 */
export async function createExpertsSession(input: CreateExpertsInput): Promise<string | undefined> {
  const result = await dispatch({
    type: "experts.create",
    projectId: input.projectId,
    topic: input.topic,
    experts: input.experts,
    lead: input.lead,
  });
  const created = result.events.find((r) => r.event.type === "experts.created");
  const sessionId = created && created.event.type === "experts.created" ? created.event.session.id : undefined;
  if (sessionId === undefined) return undefined;
  useUi.getState().selectExpertsSession(sessionId);
  await dispatch({ type: "experts.start", sessionId });
  return sessionId;
}

export function setExpertsPhase(sessionId: string, phase: ExpertsPhase): void {
  void dispatch({ type: "experts.set-phase", sessionId, phase }).catch((error: unknown) =>
    showToast(`Phase change failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

/** Posts the user's contribution to the board; `to` omitted means everyone. */
export function postToPanel(sessionId: string, text: string, to?: string): void {
  void dispatch({
    type: "experts.post",
    sessionId,
    text,
    ...(to === undefined || to === "all" ? {} : { to }),
  }).catch((error: unknown) =>
    showToast(`Post failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

export function archiveExpertsSession(sessionId: string): void {
  void dispatch({ type: "experts.archive", sessionId }).catch(() => undefined);
  useUi.getState().selectExpertsSession(null);
}

/**
 * Opens an expert's own thread in the Thread column while keeping the board
 * mounted as a workbench tab, so the panel never disappears behind one voice.
 */
export function openExpertThread(threadId: string): void {
  openExpertsTab(threadId);
  const ui = useUi.getState();
  ui.selectThread(threadId);
  if (ui.focusMode === "thread") ui.setFocusMode("split");
}
