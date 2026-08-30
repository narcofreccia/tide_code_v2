import type { ApprovalDecision, InteractionMode, ProviderKind, RuntimeMode } from "@tide/contracts";
import { call, dispatch, type DispatchResult } from "../state/model.ts";
import { showToast } from "../state/toast.ts";
import { useUi } from "../state/ui.ts";
import { ensureStatus, invalidateThread } from "../state/vcs.ts";

export interface ThreadPatch {
  title?: string;
  provider?: ProviderKind;
  model?: string;
  mode?: RuntimeMode;
  interaction?: InteractionMode;
}

export function updateThread(threadId: string, patch: ThreadPatch): void {
  void dispatch({ type: "thread.update", threadId, ...patch }).catch(() => undefined);
}

export function archiveThread(threadId: string): void {
  void dispatch({ type: "thread.archive", threadId }).catch(() => undefined);
  useUi.getState().selectThread(null);
}

/** Selects the thread a dispatch created, if it created one. */
function selectCreatedThread(result: DispatchResult): void {
  const created = result.events.find((r) => r.event.type === "thread.created");
  if (created && created.event.type === "thread.created") {
    useUi.getState().selectThread(created.event.thread.id);
  }
}

export interface NewThreadOptions {
  parentThreadId?: string;
  title?: string;
  model?: string;
  mode?: RuntimeMode;
  useWorktree?: boolean;
}

/** Creates a thread (optionally as a child) and selects it. */
export async function createThread(
  projectId: string,
  provider: ProviderKind,
  options: NewThreadOptions = {},
): Promise<void> {
  const result = await dispatch({
    type: "thread.create",
    projectId,
    provider,
    title: options.title ?? "New thread",
    ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.useWorktree === undefined ? {} : { useWorktree: options.useWorktree }),
  });
  selectCreatedThread(result);
}

export async function sendTurn(threadId: string, text: string): Promise<void> {
  await dispatch({ type: "turn.request", threadId, text });
}

export function interruptTurn(threadId: string): void {
  void dispatch({ type: "turn.interrupt", threadId }).catch(() => undefined);
}

export function respondApproval(threadId: string, requestId: string, decision: ApprovalDecision): void {
  void dispatch({ type: "approval.respond", threadId, requestId, decision }).catch(() => undefined);
}

export function respondUserInput(
  threadId: string,
  requestId: string,
  answers: Record<string, unknown>,
): void {
  void dispatch({ type: "user-input.respond", threadId, requestId, answers }).catch(() => undefined);
}

export interface ImplementPlanOptions {
  provider: ProviderKind;
  model?: string;
  mode?: RuntimeMode;
  useWorktree?: boolean;
}

/** The only path from a proposed plan to running code; never automatic. */
export async function implementPlan(planId: string, options: ImplementPlanOptions): Promise<void> {
  const result = await dispatch({
    type: "plan.implement",
    planId,
    provider: options.provider,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.useWorktree === undefined ? {} : { useWorktree: options.useWorktree }),
  });
  selectCreatedThread(result);
}

export function dismissPlan(planId: string): void {
  void dispatch({ type: "plan.dismiss", planId }).catch(() => undefined);
}

/** Escape hatch: copy the harness's own resume command for this thread. */
export async function copyTerminalCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(command);
  } catch {
    /* clipboard may be denied; the toast still shows the command */
  }
  showToast(`Copied: ${command}`);
}

/** Resolves the thread's harness resume command, or undefined when it has none. */
export async function fetchTerminalCommand(threadId: string): Promise<string | undefined> {
  const result = await call("thread.terminalCommand", { threadId });
  return result.command;
}

// ---- git (P2) ----

/** Restores the worktree to the checkpoint taken before `turnId`. */
export async function revertTurn(threadId: string, turnId: string): Promise<void> {
  try {
    await dispatch({ type: "thread.revert", threadId, turnId });
    invalidateThread(threadId);
    showToast("Reverted to the checkpoint before this turn");
  } catch (error) {
    showToast(`Revert failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface PublishOptions {
  title?: string;
  body?: string;
  /** commit without pushing or opening a PR */
  commitOnly?: boolean;
}

/** Commits the worktree, and unless `commitOnly` pushes and opens/updates the PR. */
export async function publishThread(threadId: string, options: PublishOptions = {}): Promise<void> {
  try {
    await dispatch({
      type: "thread.publish",
      threadId,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.commitOnly === undefined ? {} : { commitOnly: options.commitOnly }),
    });
    invalidateThread(threadId);
    ensureStatus(threadId, true);
    showToast(options.commitOnly ? "Committed" : "Committed, pushed, PR updated");
  } catch (error) {
    showToast(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
