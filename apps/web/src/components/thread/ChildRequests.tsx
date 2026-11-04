import { memo, useCallback, useMemo } from "react";
import { selectChildRequests } from "@tide/client";
import type { ReadModel } from "@tide/contracts";
import { useShallow } from "zustand/react/shallow";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { UserInputCard } from "./UserInputCard.tsx";
import { showSideChat } from "./useSideChat.ts";
import styles from "./ChildRequests.module.css";

const NONE: string[] = [];

interface Memo {
  threads: ReadModel["threads"];
  timeline: ReadModel["threadTimeline"];
  activities: ReadModel["activities"];
  ids: string[];
}

const memos = new Map<string, Memo>();

/**
 * The pending activity ids of a parent's children. `selectChildRequests` scans every
 * thread, so it reruns only when threads, timelines or activities were replaced, not
 * on every streaming delta.
 */
export function childRequestIds(model: ReadModel, parentId: string): string[] {
  const last = memos.get(parentId);
  if (last && last.threads === model.threads && last.timeline === model.threadTimeline && last.activities === model.activities) {
    return last.ids;
  }
  const found = selectChildRequests(model, parentId).flatMap((item) => (item.activity ? [item.activity.id] : []));
  const ids = found.length === 0 ? NONE : found;
  memos.set(parentId, { threads: model.threads, timeline: model.threadTimeline, activities: model.activities, ids });
  return ids;
}

/** Opens the child the request came from. */
export type OpenChild = (childId: string) => void;

const ChildRequest = memo(function ChildRequest({ activityId, onOpen }: { activityId: string; onOpen: OpenChild }) {
  const activity = useModel((s) => s.model.activities[activityId]);
  const childId = activity?.threadId;
  const title = useModel((s) => (childId === undefined ? undefined : s.model.threads[childId]?.title));
  const from = useMemo(
    () => (childId === undefined ? undefined : { title: title ?? childId, onOpen: () => onOpen(childId) }),
    [childId, title, onOpen],
  );
  if (!activity || !from) return null;
  if (activity.kind === "approval") return <ApprovalCard activity={activity} active={false} from={from} />;
  if (activity.kind === "user-input") return <UserInputCard activity={activity} from={from} />;
  return null;
});

/**
 * R16: approvals and questions of this thread's delegates, side chats and led experts,
 * answered in place above the composer (oldest first). Each card answers its own
 * child thread; none takes the `y` / `n` hotkeys, which stay with the parent's prompt.
 */
export const ChildRequests = memo(function ChildRequests({ threadId, onOpen }: { threadId: string; onOpen?: OpenChild }) {
  const ids = useModel(useShallow((s) => childRequestIds(s.model, threadId)));
  const selectThread = useUi((s) => s.selectThread);
  // a side chat opens as its tab beside this thread; any other child is selected
  const openChild = useCallback(
    (childId: string) => {
      if (useModel.getState().model.threads[childId]?.role === "side") showSideChat(threadId, childId);
      else selectThread(childId);
    },
    [threadId, selectThread],
  );
  const open = onOpen ?? openChild;
  if (ids.length === 0) return null;
  return (
    <section className={styles.requests} aria-label="Waiting in child threads">
      <ol className={styles.list}>
        {ids.map((id) => (
          <ChildRequest key={id} activityId={id} onOpen={open} />
        ))}
      </ol>
    </section>
  );
});
