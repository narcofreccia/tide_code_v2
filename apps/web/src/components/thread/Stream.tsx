import { memo, useMemo, useRef } from "react";
import { groupActivities, selectThreadTurnsStable, selectTimelineStable } from "@tide/client";
import type { Activity, ActivityOf, ProposedPlan, ProviderKind, Turn } from "@tide/contracts";
import type { TimelineItem } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { orderByTurn, queuedTurnIds } from "../../lib/streamOrder.ts";
import { ActivityGroup } from "./ActivityGroup.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ChildGroup } from "./ChildGroup.tsx";
import { CompactionNotice } from "./CompactionNotice.tsx";
import { compactionOf, type Compaction } from "../../lib/compaction.ts";
import { EmptyThread } from "./EmptyThread.tsx";
import { HarnessEvents, collapsePassThrough, isPassThrough } from "./HarnessEvents.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { StreamMessage } from "./StreamMessage.tsx";
import { UserInputCard } from "./UserInputCard.tsx";
import { CiteButton } from "./CiteButton.tsx";
import { activitiesByTurn, lastPendingApprovalId, listStabilizer, metaMessageIds, splitChildren } from "./streamModel.ts";
import { Icon } from "../ui/Icon.tsx";
import { useStreamScroll } from "./useStreamScroll.ts";
import styles from "./Stream.module.css";

type Note = Extract<Activity, { kind: "info" | "error" }>;

/** One stream row with its props, built once per change of this thread's timeline or turns. */
type Row =
  | { kind: "group"; key: string; activities: ActivityOf<"tool">[] }
  | { kind: "message"; key: string; showMeta: boolean; wasQueued: boolean; turnNumber: number | undefined; conclusion: Activity[] | undefined }
  | { kind: "plan"; key: string; plan: ProposedPlan }
  | { kind: "approval"; key: string; activity: ActivityOf<"approval">; active: boolean }
  | { kind: "input"; key: string; activity: ActivityOf<"user-input"> }
  | { kind: "child"; key: string; child: ActivityOf<"child">; activities: Activity[] }
  | { kind: "harness"; key: string; activities: Note[] }
  | { kind: "compaction"; key: string; activity: Activity; compaction: Compaction }
  | { kind: "activity"; key: string; activity: Activity };

/**
 * The thread's timeline shaped into rows. List props (a group's calls, a sub-agent's
 * rows, a turn's activities) keep their identity while their items do, so memoized rows
 * skip re-rendering when the rebuild was caused by another row.
 */
function buildRows(items: readonly TimelineItem[], turns: readonly Turn[], prev: ReadonlyMap<string, Activity[]>) {
  const { stable, lists } = listStabilizer<Activity>(prev);
  const entries = orderByTurn(items, turns);
  const queued = queuedTurnIds(turns);
  const split = splitChildren(entries);
  const { entries: top, groups } = collapsePassThrough(split.top);
  const liveApprovalId = lastPendingApprovalId(entries);
  const metaIds = metaMessageIds(top, turns);
  const turnActivities = activitiesByTurn(entries);
  const turnNumber = new Map(turns.map((t, i) => [t.id, i + 1] as const));
  // a harness that reports start and end as two rows (Pi): the "done" row stands for both
  const compacted = new Set<string>();
  for (const entry of top) if (entry.kind === "activity" && compactionOf(entry.activity)?.phase === "done") compacted.add(entry.activity.turnId);
  const rows: Row[] = [];
  for (const node of groupActivities(top)) {
    if (node.kind === "group") {
      rows.push({ kind: "group", key: node.id, activities: stable(node.id, node.activities) as ActivityOf<"tool">[] });
    } else if (node.kind === "message") {
      const { id, turnId } = node.message;
      const showMeta = metaIds.has(id);
      rows.push({
        kind: "message",
        key: id,
        showMeta,
        wasQueued: queued.has(turnId),
        turnNumber: turnNumber.get(turnId),
        conclusion: showMeta ? stable(`turn:${turnId}`, turnActivities.get(turnId) ?? []) : undefined,
      });
    } else if (node.kind === "plan") {
      rows.push({ kind: "plan", key: node.plan.id, plan: node.plan });
    } else {
      const activity = node.activity;
      const events = isPassThrough(activity) ? groups.get(activity.id) : undefined;
      const compaction = compactionOf(activity);
      if (compaction !== undefined) {
        if (compaction.phase === "done" || !compacted.has(activity.turnId)) rows.push({ kind: "compaction", key: activity.id, activity, compaction });
      } else if (activity.kind === "approval") rows.push({ kind: "approval", key: activity.id, activity, active: activity.id === liveApprovalId });
      else if (activity.kind === "user-input") rows.push({ kind: "input", key: activity.id, activity });
      else if (activity.kind === "child") {
        rows.push({ kind: "child", key: activity.id, child: activity, activities: stable(`child:${activity.childKey}`, split.nested.get(activity.childKey) ?? []) });
      } else if (events) rows.push({ kind: "harness", key: activity.id, activities: stable(`harness:${activity.id}`, events) as Note[] });
      else rows.push({ kind: "activity", key: activity.id, activity });
    }
  }
  return { rows, lists };
}

function renderRow(row: Row, provider: ProviderKind) {
  switch (row.kind) {
    case "group":
      return <ActivityGroup key={row.key} activities={row.activities} />;
    case "message":
      return (
        <StreamMessage
          key={row.key}
          messageId={row.key}
          provider={provider}
          showMeta={row.showMeta}
          wasQueued={row.wasQueued}
          turnNumber={row.turnNumber}
          conclusion={row.conclusion}
        />
      );
    case "plan":
      return <PlanCard key={row.key} plan={row.plan} provider={provider} />;
    case "approval":
      return <ApprovalCard key={row.key} activity={row.activity} active={row.active} />;
    case "input":
      return <UserInputCard key={row.key} activity={row.activity} />;
    case "child":
      return <ChildGroup key={row.key} child={row.child} activities={row.activities} />;
    case "harness":
      return <HarnessEvents key={row.key} activities={row.activities} />;
    case "compaction":
      return <CompactionNotice key={row.key} activity={row.activity} compaction={row.compaction} />;
    case "activity":
      return <ActivityRow key={row.key} activity={row.activity} />;
  }
}

/**
 * The thread's stream. Subscribes to this thread's timeline and turns only (stable
 * selectors), so another thread's delta renders nothing here; rows read their own slice.
 * Keyed by thread so each visit starts with fresh scroll state and restores its position.
 */
export const Stream = memo(function Stream({ threadId, provider }: { threadId: string; provider: ProviderKind }) {
  return <ThreadStream key={threadId} threadId={threadId} provider={provider} />;
});

function ThreadStream({ threadId, provider }: { threadId: string; provider: ProviderKind }) {
  const items = useModel((s) => selectTimelineStable(s.model, threadId));
  const turns = useModel((s) => selectThreadTurnsStable(s.model, threadId));
  const thread = useModel((s) => s.model.threads[threadId]);
  const lists = useRef<ReadonlyMap<string, Activity[]>>(new Map());
  const rows = useMemo(() => {
    const built = buildRows(items, turns, lists.current);
    lists.current = built.lists;
    return built.rows;
  }, [items, turns]);

  const scroller = useRef<HTMLOListElement>(null);
  const hasRows = items.length > 0;
  const { showNew, jumpToEnd } = useStreamScroll(scroller, { threadId, rowsSignature: rows, hasRows });

  if (!hasRows) {
    return thread ? <EmptyThread thread={thread} /> : <div className={styles.empty}>No messages yet.</div>;
  }

  return (
    <div className={styles.wrap}>
      <ol className={styles.stream} ref={scroller}>
        {rows.map((row) => renderRow(row, provider))}
      </ol>
      <CiteButton root={scroller} />
      {showNew ? (
        <button type="button" className={styles.newPill} onClick={jumpToEnd}>
          <Icon name="chevronDown" size={12} />
          New text
        </button>
      ) : null}
    </div>
  );
}
