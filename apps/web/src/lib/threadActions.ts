import type { ApprovalDecision, InteractionMode, LinkAccess, ProviderKind, RuntimeMode } from "@tide/contracts";
import { call, dispatch, type DispatchResult } from "../state/model.ts";
import { dispatchOrToast } from "./dispatchOrToast.ts";
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
  dispatchOrToast("Updating the thread", { type: "thread.update", threadId, ...patch });
}

/**
 * Archives a thread. `keepWorktree` is only meaningful for worktree threads —
 * the dialog asks, threads without one archive straight away.
 */
export function archiveThread(threadId: string, keepWorktree?: boolean): void {
  dispatchOrToast("Archiving the thread", {
    type: "thread.archive",
    threadId,
    ...(keepWorktree === undefined ? {} : { keepWorktree }),
  });
  useUi.getState().selectThread(null);
}

/** Opens the archive confirmation for worktree threads; archives the rest now. */
export function requestArchive(thread: { id: string; worktreePath?: string }): void {
  if (thread.worktreePath === undefined) {
    archiveThread(thread.id);
    return;
  }
  useUi.getState().setThreadDialog({ kind: "archive", threadId: thread.id });
}

/** Removes the thread's worktree directory now; the branch is kept unless asked. */
export function detachWorktree(threadId: string, deleteBranch: boolean): void {
  dispatch({
    type: "worktree.detach",
    threadId,
    ...(deleteBranch ? { deleteBranch: true } : {}),
  })
    .then(() => {
      invalidateThread(threadId);
      showToast(deleteBranch ? "Worktree removed, branch deleted" : "Worktree removed, branch kept");
    })
    .catch((error: unknown) => {
      showToast(`Detach failed: ${error instanceof Error ? error.message : String(error)}`);
    });
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
  /** per-thread link overrides; omit to inherit every project link at its default access */
  links?: { linkId: string; access: LinkAccess }[];
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
    ...(options.links === undefined ? {} : { links: options.links }),
  });
  selectCreatedThread(result);
}

export async function sendTurn(threadId: string, text: string): Promise<void> {
  await dispatch({ type: "turn.request", threadId, text });
}

export function interruptTurn(threadId: string): void {
  dispatchOrToast("Stopping the turn", { type: "turn.interrupt", threadId });
}

export function respondApproval(threadId: string, requestId: string, decision: ApprovalDecision): void {
  dispatchOrToast("Answering the approval", { type: "approval.respond", threadId, requestId, decision });
}

export function respondUserInput(
  threadId: string,
  requestId: string,
  answers: Record<string, unknown>,
): void {
  dispatchOrToast("Answering the question", { type: "user-input.respond", threadId, requestId, answers });
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
  dispatchOrToast("Dismissing the plan", { type: "plan.dismiss", planId });
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
