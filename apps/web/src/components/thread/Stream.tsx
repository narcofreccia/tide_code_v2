import { Fragment, useEffect, useRef, useState } from "react";
import { groupActivities, selectThreadTurns, selectTimeline, type TimelineItem } from "@tide/client";
import type { Activity, ActivityOf, ProviderKind, ReadModel, TurnStatus } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { orderByTurn, queuedTurnIds } from "../../lib/streamOrder.ts";
import { ActivityGroup } from "./ActivityGroup.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ChildGroup } from "./ChildGroup.tsx";
import { EmptyThread } from "./EmptyThread.tsx";
import { HarnessEvents, collapsePassThrough, isPassThrough } from "./HarnessEvents.tsx";
import { HandoffCard } from "./HandoffCard.tsx";
import { NoticeRow } from "./NoticeRow.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { UserInputCard } from "./UserInputCard.tsx";
import { CiteButton } from "./CiteButton.tsx";
import styles from "./Stream.module.css";

const BOTTOM_SLACK = 48;

interface Split {
  top: TimelineItem[];
  /** childKey -> the sub-agent's own activities, pulled out of the main flow */
  nested: Map<string, Activity[]>;
}

/** Moves sub-agent output under its child header so the main flow stays readable. */
function splitChildren(entries: TimelineItem[]): Split {
  const children = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind === "child") children.add(entry.activity.childKey);
  }
  const nested = new Map<string, Activity[]>();
  const top: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind !== "child") {
      const parent = entry.activity.parentToolUseId;
      if (parent !== undefined && children.has(parent)) {
        nested.set(parent, [...(nested.get(parent) ?? []), entry.activity]);
        continue;
      }
    }
    top.push(entry);
  }
  return { top, nested };
}

const SETTLED: TurnStatus[] = ["completed", "error", "interrupted"];

/**
 * The messages that carry a turn footer: the last assistant message of every
 * turn that has settled. A turn still running keeps its numbers to itself.
 */
function metaMessageIds(entries: TimelineItem[], model: ReadModel): Set<string> {
  const last = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "assistant") {
      last.set(entry.message.turnId, entry.message.id);
    }
  }
  const out = new Set<string>();
  for (const [turnId, messageId] of last) {
    const turn = model.turns[turnId];
    if (turn && SETTLED.includes(turn.status)) out.add(messageId);
  }
  return out;
}

function lastPendingApprovalId(entries: TimelineItem[]): string | undefined {
  let id: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind === "approval" && entry.activity.status === "pending") {
      id = entry.activity.id;
    }
  }
  return id;
}

export function Stream({ threadId, provider }: { threadId: string; provider: ProviderKind }) {
  const model = useModel((s) => s.model);
  const turns = selectThreadTurns(model, threadId);
  const entries = orderByTurn(selectTimeline(model, threadId), turns);
  const queuedTurns = queuedTurnIds(turns);
  const split = splitChildren(entries);
  const { entries: top, groups } = collapsePassThrough(split.top);
  const nested = split.nested;
  const thread = model.threads[threadId];
  const nodes = groupActivities(top);
  const liveApprovalId = lastPendingApprovalId(entries);
  const metaIds = metaMessageIds(top, model);
  const turnNumber = new Map(turns.map((t, i) => [t.id, i + 1]));
  const citeLabel = (turnId: string): string => {
    const n = turnNumber.get(turnId);
    const title = thread?.title ?? "this thread";
    return n === undefined ? `"${title}"` : `turn ${n} of "${title}"`;
  };

  const scroller = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  const toBottom = (): void => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setHasNew(false);
  };

  const signature = entries.length + ":" + (model.seq || 0);
  useEffect(() => {
    if (atBottom.current) toBottom();
    else setHasNew(true);
  }, [signature]);

  if (entries.length === 0) {
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
          if (atBottom.current) setHasNew(false);
        }}
      >
        {nodes.map((node) => {
          if (node.kind === "group") return <ActivityGroup key={node.id} activities={node.activities} />;
          if (node.kind === "message") {
            if (node.message.notification !== undefined) return <NoticeRow key={node.message.id} message={node.message} />;
            const turn = model.turns[node.message.turnId];
            const handoff =
              node.message.role === "user" && node.message.steer !== true && turn?.handoffId !== undefined
                ? model.handoffs[turn.handoffId]
                : undefined;
            return (
              <Fragment key={node.message.id}>
                {handoff ? <HandoffCard handoff={handoff} delivery={turn?.handoffDelivery} /> : null}
                <MessageItem
                  message={node.message}
                  {...(turn === undefined ? {} : { turn })}
                  {...(metaIds.has(node.message.id) ? { showMeta: true } : {})}
                  {...(queuedTurns.has(node.message.turnId) ? { wasQueued: true } : {})}
                  {...(node.message.role === "assistant" ? { citeLabel: citeLabel(node.message.turnId) } : {})}
                />
              </Fragment>
            );
          }
          if (node.kind === "plan") return <PlanCard key={node.plan.id} plan={node.plan} provider={provider} />;
          const activity = node.activity;
          if (activity.kind === "approval") {
            return (
              <ApprovalCard key={activity.id} activity={activity} active={activity.id === liveApprovalId} />
            );
          }
          if (activity.kind === "user-input") return <UserInputCard key={activity.id} activity={activity} />;
          if (activity.kind === "child") {
            const child: ActivityOf<"child"> = activity;
            return <ChildGroup key={child.id} child={child} activities={nested.get(child.childKey) ?? []} />;
          }
          if (isPassThrough(activity)) {
            const events = groups.get(activity.id);
            if (events) return <HarnessEvents key={activity.id} activities={events} />;
          }
          return <ActivityRow key={activity.id} activity={activity} />;
        })}
      </ol>
      <CiteButton root={scroller} />
      {hasNew ? (
        <button type="button" className={styles.newPill} onClick={toBottom}>
          ↓ new
        </button>
      ) : null}
    </div>
  );
}
