import { memo, useEffect, useMemo, useRef, useState } from "react";
import { groupActivities, selectThreadTurnsStable, selectTimelineStable } from "@tide/client";
import type { Activity, ActivityOf, ProposedPlan, ProviderKind, Turn } from "@tide/contracts";
import type { TimelineItem } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { orderByTurn, queuedTurnIds } from "../../lib/streamOrder.ts";
import { ActivityGroup } from "./ActivityGroup.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ChildGroup } from "./ChildGroup.tsx";
import { EmptyThread } from "./EmptyThread.tsx";
import { HarnessEvents, collapsePassThrough, isPassThrough } from "./HarnessEvents.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { StreamMessage } from "./StreamMessage.tsx";
import { UserInputCard } from "./UserInputCard.tsx";
import { CiteButton } from "./CiteButton.tsx";
import { activitiesByTurn, lastPendingApprovalId, listStabilizer, metaMessageIds, splitChildren } from "./streamModel.ts";
import { Icon } from "../ui/Icon.tsx";
import styles from "./Stream.module.css";

const BOTTOM_SLACK = 48;

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
      if (activity.kind === "approval") rows.push({ kind: "approval", key: activity.id, activity, active: activity.id === liveApprovalId });
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
    case "activity":
      return <ActivityRow key={row.key} activity={row.activity} />;
  }
}

/**
 * The thread's stream. Subscribes to this thread's timeline and turns only (stable
 * selectors), so another thread's delta renders nothing here; rows read their own slice.
 */
export const Stream = memo(function Stream({ threadId, provider }: { threadId: string; provider: ProviderKind }) {
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
  const atBottom = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const showsNew = useRef(false);
  const setNew = (value: boolean): void => {
    if (showsNew.current === value) return;
    showsNew.current = value;
    setHasNew(value);
  };

  const toBottom = (): void => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNew(false);
  };

  // this thread changed: a new row, a delta on one of its messages, or a turn settling (footer)
  useEffect(() => {
    if (atBottom.current) toBottom();
    else setNew(true);
  }, [rows]);

  if (items.length === 0) {
    return thread ? <EmptyThread thread={thread} /> : <div className={styles.empty}>No messages yet.</div>;
  }

  return (
    <div className={styles.wrap}>
      <ol
        className={styles.stream}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
          if (atBottom.current) setNew(false);
        }}
      >
        {rows.map((row) => renderRow(row, provider))}
      </ol>
      <CiteButton root={scroller} />
      {hasNew ? (
        <button type="button" className={styles.newPill} onClick={toBottom}>
          <Icon name="chevronDown" size={12} />
          New text
        </button>
      ) : null}
    </div>
  );
});
