import type {
  ApprovalDecision,
  ImageInput,
  InteractionMode,
  LinkAccess,
  MergeStrategy,
  ProviderKind,
  RuntimeMode,
  Thread,
} from "@tide/contracts";
import { descendantThreads } from "@tide/client";
import { newId } from "@tide/contracts";
import { call, dispatch, useModel, type DispatchResult } from "../state/model.ts";
import { plural } from "./format.ts";
import { dispatchOrToast, errorText } from "./dispatchOrToast.ts";
import { showToast } from "../state/toast.ts";
import { useUi } from "../state/ui.ts";
import { ensureStatus, invalidateThread } from "../state/vcs.ts";

export interface ThreadPatch {
  title?: string;
  provider?: ProviderKind;
  model?: string;
  mode?: RuntimeMode;
  interaction?: InteractionMode;
  pinned?: boolean;
  autoAllowRoutine?: boolean;
  autoSettle?: boolean;
}

export function updateThread(threadId: string, patch: ThreadPatch): void {
  dispatchOrToast("Updating the thread", { type: "thread.update", threadId, ...patch });
}

/** The thread's title as the read model knows it, for toasts. */
function titleOf(threadId: string): string {
  return useModel.getState().model.threads[threadId]?.title ?? "thread";
}

/** Brings an archived thread back into the rail; its worktree is not recreated. */
export function unarchiveThread(threadId: string): void {
  dispatchOrToast("Restoring the thread", { type: "thread.unarchive", threadId });
}

/**
 * Archives a thread. `keepWorktree` is only meaningful for worktree threads —
 * the dialog asks, threads without one archive straight away. The toast offers
 * Undo (`thread.unarchive`) for a few seconds.
 */
export function archiveThread(threadId: string, keepWorktree?: boolean): void {
  const title = titleOf(threadId);
  // archived from inside the thread: Undo also brings the user back to it
  const wasOpen = useUi.getState().selectedThreadId === threadId;
  const undo = (): void => {
    unarchiveThread(threadId);
    if (wasOpen) useUi.getState().selectThread(threadId);
  };
  dispatch({
    type: "thread.archive",
    threadId,
    ...(keepWorktree === undefined ? {} : { keepWorktree }),
  })
    .then(() => showToast(`Archived “${title}”`, { label: "Undo", onClick: undo }))
    .catch((error: unknown) => showToast(`Archiving the thread failed: ${errorText(error)}`));
  if (wasOpen) useUi.getState().selectThread(null);
}

/** True when the thread has no conversation at all: nothing to confirm or archive. */
export function isEmptyThread(threadId: string): boolean {
  return (useModel.getState().model.threadMessages[threadId]?.length ?? 0) === 0;
}

/** Descendants (forks, delegates; archived too) of a thread, from the live model. */
function descendantsOf(threadId: string): Thread[] {
  return descendantThreads(useModel.getState().model, threadId);
}

/**
 * Hard-deletes a thread, its branch and checkpoints. With `cascade` the whole subtree
 * goes too; the server refuses while the thread (or a descendant) runs or another
 * thread shares its worktree.
 */
export function deleteThread(threadId: string, opts: { cascade?: boolean } = {}): void {
  const title = titleOf(threadId);
  const children = opts.cascade ? descendantsOf(threadId).length : 0;
  if (useUi.getState().selectedThreadId === threadId) useUi.getState().selectThread(null);
  dispatch({ type: "thread.delete", threadId, ...(opts.cascade ? { cascade: true } : {}) })
    .then(() =>
      showToast(children > 0 ? `Deleted “${title}” and ${plural(children, "child thread")}` : `Deleted “${title}”`),
    )
    .catch((error: unknown) => showToast(`Deleting the thread failed: ${errorText(error)}`));
}

/** True when deleting needs a confirmation: a conversation or child threads. */
export function deleteNeedsConfirm(threadId: string): boolean {
  return !isEmptyThread(threadId) || descendantsOf(threadId).length > 0;
}

/** Opens the delete confirmation; an empty thread without children goes straight away. */
export function requestDelete(thread: { id: string }): void {
  if (!deleteNeedsConfirm(thread.id)) {
    deleteThread(thread.id);
    return;
  }
  useUi.getState().setThreadDialog({ kind: "delete", threadId: thread.id });
}

/** Deletes every archived thread of a project that has no turns and no children. */
export function clearEmptyArchived(threads: { id: string }[]): void {
  const empty = threads.filter((t) => isEmptyThread(t.id) && descendantsOf(t.id).length === 0);
  if (empty.length === 0) {
    showToast("No empty archived threads");
    return;
  }
  Promise.allSettled(empty.map((t) => dispatch({ type: "thread.delete", threadId: t.id }))).then((results) => {
    const ok = results.filter((r) => r.status === "fulfilled").length;
    showToast(`Deleted ${ok} empty ${ok === 1 ? "thread" : "threads"}`);
  });
}

/** R7: false = the settlement reactor never settles this thread on its own. */
export function setAutoSettle(threadId: string, autoSettle: boolean): void {
  updateThread(threadId, { autoSettle });
}

export {
  regenerateTitles,
  settleThread,
  settleThreads,
  snoozeThreads,
  undoLastSettle,
  unsettleThread,
} from "./inboxActions.ts";

export function setThreadPinned(threadId: string, pinned: boolean): void {
  updateThread(threadId, { pinned });
}

/** `+ child`: opens the new-thread form with the parent filled in, instead of creating blind. */
export function createChild(thread: { id: string; projectId: string }): void {
  useUi.getState().openNewThread({ projectId: thread.projectId, parentThreadId: thread.id });
}

/** Copies a value and confirms it with a toast. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    showToast(`Copied ${what}`);
  } catch {
    showToast(`Could not copy the ${what}`);
  }
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
export function selectCreatedThread(result: DispatchResult): void {
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
  interaction?: InteractionMode;
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
    ...(options.interaction === undefined ? {} : { interaction: options.interaction }),
    ...(options.useWorktree === undefined ? {} : { useWorktree: options.useWorktree }),
    ...(options.links === undefined ? {} : { links: options.links }),
  });
  selectCreatedThread(result);
}

/**
 * Sends a prompt. The server queues it when the thread is already running, so
 * this is also how a follow-up is stacked behind the live turn. `requestId` is
 * the idempotency key: the caller keeps the same one when it retries a send
 * that failed in flight, so a reconnect can never run the prompt twice.
 */
export async function sendTurn(
  threadId: string,
  text: string,
  images?: ImageInput[],
  requestId: string = newId(),
): Promise<void> {
  await dispatch({
    type: "turn.request",
    threadId,
    text,
    requestId,
    ...(images === undefined || images.length === 0 ? {} : { images }),
  });
}

/** True when a turn with this idempotency key already reached the server. */
export function turnRequestLanded(threadId: string, requestId: string): boolean {
  return Object.values(useModel.getState().model.turns).some(
    (t) => t.threadId === threadId && t.requestId === requestId,
  );
}

/** Drops a turn that is still waiting in the queue; its message disappears. */
export function dequeueTurn(turnId: string): void {
  dispatchOrToast("Removing the queued turn", { type: "turn.dequeue", turnId });
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

export interface PublishOptions {
  title?: string;
  body?: string;
  /** commit without pushing or opening a PR */
  commitOnly?: boolean;
  /** after opening the PR, let GitHub merge it with this strategy once checks pass */
  mergeWhenGreen?: MergeStrategy;
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
      ...(options.mergeWhenGreen === undefined || options.commitOnly === true
        ? {}
        : { mergeWhenGreen: options.mergeWhenGreen }),
    });
    invalidateThread(threadId);
    ensureStatus(threadId, true);
    showToast(
      options.commitOnly
        ? "Committed"
        : options.mergeWhenGreen
          ? "Committed, pushed, PR set to merge when green"
          : "Committed, pushed, PR updated",
    );
  } catch (error) {
    showToast(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface MergeOptions {
  strategy?: MergeStrategy;
  /** remove the thread's branch (and worktree) once merged */
  deleteBranch?: boolean;
}

/**
 * Merges the thread's branch back into its base (or merges its PR). The outcome
 * arrives later on `thread.merge`; only a refusal to start is reported here.
 */
export async function mergeThread(threadId: string, options: MergeOptions = {}): Promise<void> {
  try {
    await dispatch({
      type: "thread.merge",
      threadId,
      ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
      ...(options.deleteBranch === true ? { deleteBranch: true } : {}),
    });
  } catch (error) {
    showToast(`Merge failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
