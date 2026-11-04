import { selectThreadMessages, selectThreadTurns } from "@tide/client";
import type { Message, ReadModel } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { applyCompose, citeBlock, compose } from "../../lib/cite.ts";
import { getDraft, setDraft } from "../../state/drafts.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { deleteThread, sendTurn } from "../../lib/threadActions.ts";
import { dispatch, useModel, type DispatchResult } from "../../state/model.ts";
import { showToast } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import { closeSideTab, openSideTab } from "../../state/workbench.ts";

/**
 * R16: side chats (`/side`, `/btw`). A side chat is a thread with role `side` the server
 * forks beside its parent on the parent's checkout; Tide shows it as a tab in the
 * parent's workbench and can bring its last answer back into the parent's draft.
 */

/** The side thread a `thread.side` receipt created. */
export function createdSideId(result: DispatchResult): string | undefined {
  for (const record of result.events) {
    if (record.event.type === "thread.created") return record.event.thread.id;
  }
  return undefined;
}

export interface OpenSideOptions {
  /** the composer held images or files: they stay in the main draft */
  hadAttachments?: boolean;
}

/**
 * Asks the server for a side chat of `parentId`, opens its tab (switching Thread focus to
 * Split so the pane shows) and sends `prompt` as its first turn (none when empty).
 * Resolves to the side thread's id, or undefined when the server refused.
 */
export async function openSideChat(parentId: string, prompt: string, options: OpenSideOptions = {}): Promise<string | undefined> {
  if (options.hadAttachments) showToast("Side chats take text only");
  let sideId: string | undefined;
  try {
    sideId = createdSideId(await dispatch({ type: "thread.side", commandId: newId(), threadId: parentId }));
  } catch (error: unknown) {
    showToast(`Side chat failed: ${errorText(error)}`);
    return undefined;
  }
  if (sideId === undefined) {
    showToast("Side chat failed: the server created no thread");
    return undefined;
  }
  showSideChat(parentId, sideId);
  if (prompt !== "") {
    try {
      await sendTurn(sideId, prompt);
    } catch (error: unknown) {
      showToast(`Sending to the side chat failed: ${errorText(error)}`);
    }
  }
  return sideId;
}

/** True while a side thread has had no turn: closing it leaves nothing behind. */
export function sideChatUnused(model: ReadModel, sideId: string): boolean {
  return selectThreadTurns(model, sideId).length === 0 && (model.threadMessages[sideId]?.length ?? 0) === 0;
}

/** Closes the tab; an unused side chat is deleted, a used one stays reachable from the header. */
export function closeSideChat(parentId: string, sideId: string): void {
  closeSideTab(parentId, sideId);
  const model = useModel.getState().model;
  if (model.threads[sideId] !== undefined && sideChatUnused(model, sideId)) deleteThread(sideId);
}

/** The side chat's last finished assistant reply, if any. */
export function lastSideAnswer(model: ReadModel, sideId: string): Message | undefined {
  const messages = selectThreadMessages(model, sideId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.streaming !== true && m.text.trim() !== "") return m;
  }
  return undefined;
}

/** Why "Bring back" is off right now, or undefined when it can run. */
export function bringBackBlocked(model: ReadModel, sideId: string): string | undefined {
  const side = model.threads[sideId];
  if (!side) return "side chat is gone";
  if (side.status === "running") return "the side chat is still answering";
  return lastSideAnswer(model, sideId) === undefined ? "no answer yet" : undefined;
}

/**
 * Fills `threadId`'s composer. In Code focus that composer is not mounted: the draft is
 * written directly and Split brings the composer back with it.
 */
function composeInto(threadId: string, text: string, mode: "append" | "replace"): void {
  const ui = useUi.getState();
  if (ui.focusMode !== "workbench") {
    compose(text, mode, threadId);
    return;
  }
  setDraft(threadId, { text: applyCompose(getDraft(threadId)?.text ?? "", { text, mode }) });
  ui.setFocusMode("split");
}

/** Quotes the side chat's last answer into the parent's draft (never sends). */
export function bringBack(sideId: string, parentId: string): void {
  const model = useModel.getState().model;
  const answer = bringBackBlocked(model, sideId) === undefined ? lastSideAnswer(model, sideId) : undefined;
  if (!answer) return;
  composeInto(parentId, citeBlock(answer.text, `side chat “${model.threads[sideId]?.title ?? "side chat"}”`), "append");
}

/** The header's "Side chat…": `/side ` in front of the draft, the caret after it. */
export function startSideChat(parentId: string): void {
  const current = getDraft(parentId)?.text ?? "";
  if (/^\/(side|btw)(\s|$)/.test(current)) {
    composeInto(parentId, current, "replace");
    return;
  }
  composeInto(parentId, `/side ${current.trimStart()}`, "replace");
}

/** Shows a side chat: its tab in the parent's workbench, Thread focus widened to Split. */
export function showSideChat(parentId: string, sideId: string): void {
  openSideTab(parentId, sideId);
  const ui = useUi.getState();
  if (ui.focusMode === "thread") ui.setFocusMode("split");
}

const ACTIONS = { open: openSideChat, close: closeSideChat, bringBack, start: startSideChat, show: showSideChat } as const;

/** The side-chat actions (stable: plain functions over the stores). */
export function useSideChat(): typeof ACTIONS {
  return ACTIONS;
}
