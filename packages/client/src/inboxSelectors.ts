import type { ActivityOf, AttentionKind, ProposedPlan, ReadModel, Thread } from "@tide/contracts";
import { selectLimitReady } from "./limitSelectors.ts";
import { isSettled, isSnoozed, selectThreadsNeedingAttention } from "./selectors.ts";

/** What an inbox row waits on: a harness card, or (R20) a limit that reset and waits for Continue. */
export type InboxAttention = AttentionKind | "limit";

/** One inbox row: one thing waiting on the user, with the thread it belongs to. */
export interface InboxItem {
  /** stable row key: the activity / plan id, `thread:<id>` for a bare attention flag, `limit:<id>` for a reset limit */
  key: string;
  thread: Thread;
  attention: InboxAttention;
  /** the pending approval / user-input activity behind this row */
  activity?: ActivityOf<"approval"> | ActivityOf<"user-input">;
  /** the proposed plan behind this row */
  plan?: ProposedPlan;
  /** when the harness started waiting (the request's creation time) */
  since: number;
  /** summary of a server-authored wake-up in the thread's latest turn */
  notification?: string;
}

function latestNotification(model: ReadModel, thread: Thread): string | undefined {
  const ids = model.threadMessages[thread.id] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const m = model.messages[ids[i] ?? ""];
    if (!m || m.turnId !== thread.latestTurnId) continue;
    if (m.notification) return m.notification.summary;
  }
  return undefined;
}

/** Every pending approval / question and proposed plan of a thread, in timeline order. */
export function selectWaitingOn(model: ReadModel, thread: Thread): InboxItem[] {
  const out: InboxItem[] = [];
  for (const entry of model.threadTimeline[thread.id] ?? []) {
    if (entry.kind === "plan") {
      const plan = model.plans[entry.id];
      if (plan && plan.status === "proposed") {
        out.push({ key: plan.id, thread, attention: "plan", plan, since: plan.createdAt });
      }
      continue;
    }
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (!a || (a.kind !== "approval" && a.kind !== "user-input") || a.status !== "pending") continue;
    if (a.kind === "approval") out.push({ key: a.id, thread, attention: "approval", activity: a, since: a.createdAt });
    else out.push({ key: a.id, thread, attention: "question", activity: a, since: a.createdAt });
  }
  return out;
}

/** Urgency from the optional decisions model; rows without it sort after every row with it. */
function urgencyOf(item: InboxItem): number {
  return item.thread.triage?.urgency ?? -1;
}

/** 1 for an approval the judge rated consequential: those come first. */
function consequentialOf(item: InboxItem): number {
  return item.activity?.kind === "approval" && item.activity.judge?.label === "consequential" ? 1 : 0;
}

/**
 * Everything waiting on the user — every pending card, not one per thread.
 * Ordered by triage urgency (highest first) when the decisions model scored the
 * thread, then by how long it has been waiting (oldest first). A thread flagged
 * by the projector whose card is not in the timeline still gets one bare row. A limited thread
 * whose window reopened, with the `manual` policy, waits on the user too (`limit` row).
 */
export function selectInbox(model: ReadModel, projectId?: string, now: number = Date.now()): InboxItem[] {
  const out: InboxItem[] = [];
  for (const thread of selectThreadsNeedingAttention(model, projectId, now)) {
    const note = latestNotification(model, thread);
    const items = selectWaitingOn(model, thread).map((i) => (note === undefined ? i : { ...i, notification: note }));
    if (items.length > 0) out.push(...items);
    else if (thread.attention !== undefined) {
      out.push({
        key: `thread:${thread.id}`,
        thread,
        attention: thread.attention,
        since: thread.updatedAt,
        ...(note === undefined ? {} : { notification: note }),
      });
    }
  }
  const listed = new Set(out.map((i) => i.thread.id));
  for (const thread of selectLimitReady(model, projectId, now)) {
    if (listed.has(thread.id) || isSettled(thread) || isSnoozed(thread, now)) continue;
    out.push({ key: `limit:${thread.id}`, thread, attention: "limit", since: thread.limited?.resetsAt ?? thread.limited?.at ?? thread.updatedAt });
  }
  return out.sort(
    (a, b) => consequentialOf(b) - consequentialOf(a) || urgencyOf(b) - urgencyOf(a) || a.since - b.since || a.key.localeCompare(b.key),
  );
}
