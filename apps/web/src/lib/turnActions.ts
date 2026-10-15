import type { ImageInput, ProviderKind } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { dispatch, type DispatchResult } from "../state/model.ts";
import { invalidateThread } from "../state/vcs.ts";
import { showToast } from "../state/toast.ts";
import { dispatchOrToast, errorText } from "./dispatchOrToast.ts";
import { selectCreatedThread } from "./threadActions.ts";

/** Delivers a message into the running turn; the server queues it when the harness refuses. */
export async function steerTurn(
  threadId: string,
  text: string,
  images?: ImageInput[],
  commandId: string = newId(),
): Promise<void> {
  await dispatch({
    type: "turn.steer",
    threadId,
    text,
    commandId,
    ...(images === undefined || images.length === 0 ? {} : { images }),
  });
}

/** Rewrites a queued turn. Resolves to false (after a toast) when the server refuses. */
export async function editQueuedTurn(turnId: string, text: string): Promise<boolean> {
  try {
    await dispatch({ type: "turn.edit", turnId, text, commandId: newId() });
    return true;
  } catch (error) {
    showToast(`Editing the queued turn failed: ${errorText(error)}`);
    return false;
  }
}

/** `turnIds` is the full new order of the thread's queued turns. */
export function reorderQueue(threadId: string, turnIds: string[]): void {
  dispatchOrToast("Reordering the queue", { type: "turn.reorder", threadId, turnIds, commandId: newId() });
}

/** Sends a queued turn into the running one as a steer. */
export function promoteTurn(turnId: string): void {
  dispatchOrToast("Sending as steer", { type: "turn.promote", turnId, commandId: newId() });
}

/** Undoes `turnId` and everything after it. The outcome arrives on `thread.rollback`. */
export async function rollbackThread(threadId: string, turnId: string, restoreFiles: boolean): Promise<void> {
  try {
    await dispatch({ type: "thread.rollback", threadId, turnId, restoreFiles, commandId: newId() });
    if (restoreFiles) invalidateThread(threadId);
  } catch (error) {
    showToast(`Rollback failed: ${errorText(error)}`);
  }
}

export interface ForkOptions {
  title?: string;
  provider?: ProviderKind;
  model?: string;
  useWorktree?: boolean;
}

/** Forks the thread at a settled turn and selects the new thread. */
export async function forkThread(threadId: string, turnId: string, options: ForkOptions = {}): Promise<void> {
  try {
    const result: DispatchResult = await dispatch({
      type: "thread.fork",
      threadId,
      turnId,
      commandId: newId(),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined || options.model === "" ? {} : { model: options.model }),
      ...(options.useWorktree === undefined ? {} : { useWorktree: options.useWorktree }),
    });
    selectCreatedThread(result);
  } catch (error) {
    showToast(`Fork failed: ${errorText(error)}`);
  }
}

export function snoozeThread(threadId: string, until: number): void {
  dispatchOrToast("Snoozing the thread", { type: "thread.snooze", threadId, until, commandId: newId() });
}

export function resumeThread(threadId: string, continueNow: boolean): void {
  dispatchOrToast("Resuming the thread", {
    type: "thread.resume",
    threadId,
    commandId: newId(),
    ...(continueNow ? { continue: true } : {}),
  });
}

export function setLimitPolicy(threadId: string, resume: "manual" | "reset"): void {
  dispatchOrToast("Saving the limit policy", { type: "thread.limit-policy", threadId, resume, commandId: newId() });
}

export function watchPr(threadId: string, enabled: boolean): void {
  dispatchOrToast("Updating PR watch", { type: "pr.watch", threadId, enabled, commandId: newId() });
}
