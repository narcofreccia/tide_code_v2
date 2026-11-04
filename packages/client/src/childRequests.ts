import type { ReadModel, Thread } from "@tide/contracts";
import { selectWaitingOn, type InboxItem } from "./inboxSelectors.ts";
import { isSnoozed } from "./selectors.ts";

/**
 * R16: the threads a parent answers for — its delegates and team stages (`delegatedBy`),
 * its side chats (`role: "side"` + `parentThreadId`) and, when it leads an Experts
 * session, that session's experts. Forks are independent threads and are not children.
 * Archived and snoozed children are skipped (the inbox skips them too).
 */
export function childThreadsOf(model: ReadModel, parentId: string, now: number = Date.now()): Thread[] {
  const parent = model.threads[parentId];
  if (!parent) return [];
  const leadOf = parent.role === "lead" ? parent.expertsSessionId : undefined;
  return Object.values(model.threads)
    .filter((t) => {
      if (t.id === parentId || t.archivedAt !== undefined || isSnoozed(t, now)) return false;
      if (t.delegatedBy === parentId) return true;
      if (t.role === "side" && t.parentThreadId === parentId) return true;
      return leadOf !== undefined && t.role === "expert" && t.expertsSessionId === leadOf;
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Pending approvals and questions of a parent's children, oldest first, so the parent
 * thread can answer them in place. Proposed plans are left out: a plan is a decision
 * to make inside the child, not a card to tick from outside.
 */
export function selectChildRequests(model: ReadModel, parentId: string, now: number = Date.now()): InboxItem[] {
  const out: InboxItem[] = [];
  for (const child of childThreadsOf(model, parentId, now)) {
    for (const item of selectWaitingOn(model, child)) {
      if (item.attention === "plan") continue;
      out.push(item);
    }
  }
  return out.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
}

/** True when any child of `parentId` waits on the user — the rail dot on a parent whose children are hidden. */
export function selectChildAttention(model: ReadModel, parentId: string, now: number = Date.now()): boolean {
  return childThreadsOf(model, parentId, now).some((t) => t.attention !== undefined);
}
