import type { InternalCommand, Project, ProviderSession, Thread, TurnInput } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { inlinePrompt, planHandoffDelivery, type DeliveryPlan } from "./handoffDelivery.ts";
import { instanceIdOf, type OpenHints, type SessionDirectory } from "./sessions.ts";

/** Cancels a pending timer. */
export type CancelTimer = () => void;

/** how long a turn waits for the handoff judge's refine before shipping the recency selection */
export const HANDOFF_READY_WAIT_MS = 1_500;

/** What opening a turn's session needs from the reactor. */
export interface OpenTurnDeps {
  engine: Engine;
  sessions: SessionDirectory;
  /** resolves when the handoff judge is done with `handoffId` (undefined: nothing running) */
  handoffReady: ((handoffId: string) => Promise<void> | undefined) | undefined;
  schedule: (fn: () => void, ms: number) => CancelTimer;
  dispatch: (command: InternalCommand) => Promise<void>;
  log: (msg: string, data?: unknown) => void;
}

/**
 * Gets the thread's session and the prompt to send. A turn carrying a handoff is delivered
 * natively when the harness can fork its source session (then `rollback` trims the turns after
 * the fork point), otherwise the history goes inline ahead of the user's text.
 */
export async function openTurn(deps: OpenTurnDeps, thread: Thread, project: Project, turnId: string, input: TurnInput): Promise<{ session: ProviderSession; prompt: TurnInput }> {
  const { engine, sessions } = deps;
  const handoffId = engine.getModel().turns[turnId]?.handoffId;
  // R17: the turn after a session boundary opens a brand-new native session (a native fork wins)
  const hints: OpenHints = engine.getModel().turns[turnId]?.freshSession === true ? { fresh: true } : {};
  if (handoffId !== undefined) await awaitHandoff(deps, handoffId);
  const model = engine.getModel();
  let plan: DeliveryPlan | undefined;
  if (handoffId !== undefined) {
    let caps = {};
    try {
      caps = await sessions.caps(instanceIdOf(thread));
    } catch (err) {
      deps.log("[reactor] could not read driver caps", err);
    }
    plan = planHandoffDelivery(model, thread, turnId, caps);
  }
  if (plan === undefined) return { session: await sessions.getOrOpen(thread, project, hints), prompt: input };
  let delivery = plan.delivery;
  let session: ProviderSession | undefined;
  // a live session (should not exist on a fork's first turn) would ignore the fork request
  if (plan.delivery === "native" && sessions.peek(thread.id) === undefined) {
    const { forkFrom, rollback } = plan;
    try {
      session = await sessions.getOrOpen(thread, project, { forkFrom });
      if (rollback > 0) {
        if (session.rollback === undefined) throw new Error(`${thread.provider} driver does not implement rollback`);
        await session.rollback(rollback);
      }
    } catch (err) {
      deps.log("[reactor] native fork failed; delivering the handoff inline", err);
      await sessions.close(thread.id);
      session = undefined;
      delivery = "inline";
    }
  } else delivery = "inline";
  session ??= await sessions.getOrOpen(thread, project, hints);
  await deps.dispatch({ type: "handoff.delivered", turnId, delivery });
  // re-read: a refine that landed while the session opened is the text to ship (later ones are refused)
  const handoff = engine.getModel().handoffs[plan.handoff.id] ?? plan.handoff;
  return { session, prompt: delivery === "native" ? input : { ...input, text: inlinePrompt(handoff, input.text) } };
}

/** Gives the handoff judge a short window to refine the selection; never blocks a turn longer. */
async function awaitHandoff(deps: OpenTurnDeps, handoffId: string): Promise<void> {
  let ready: Promise<void> | undefined;
  try {
    ready = deps.handoffReady?.(handoffId);
  } catch (err) {
    deps.log("[reactor] handoffReady failed", err);
  }
  if (ready === undefined) return;
  let cancel: CancelTimer | undefined;
  const timeout = new Promise<void>((resolve) => {
    cancel = deps.schedule(resolve, HANDOFF_READY_WAIT_MS);
  });
  try {
    await Promise.race([ready.catch(() => undefined), timeout]);
  } finally {
    cancel?.();
  }
}
