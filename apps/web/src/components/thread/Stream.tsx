import { useEffect, useRef, useState } from "react";
import { groupActivities, selectTimeline, type TimelineItem } from "@tide/client";
import type { Activity, ActivityOf, ProviderKind } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { ActivityGroup } from "./ActivityGroup.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ChildGroup } from "./ChildGroup.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { UserInputCard } from "./UserInputCard.tsx";
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
  const entries = selectTimeline(model, threadId);
  const { top, nested } = splitChildren(entries);
  const nodes = groupActivities(top);
  const liveApprovalId = lastPendingApprovalId(entries);

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
    return <div className={styles.empty}>No messages yet. Send the first prompt below.</div>;
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
          if (node.kind === "message") return <MessageItem key={node.message.id} message={node.message} />;
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
          return <ActivityRow key={activity.id} activity={activity} />;
        })}
      </ol>
      {hasNew ? (
        <button type="button" className={styles.newPill} onClick={toBottom}>
          ↓ new
        </button>
      ) : null}
    </div>
  );
}
