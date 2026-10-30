import { useEffect } from "react";
import { useModel } from "../../state/model.ts";
import { activityCount, markSeen } from "../../state/lastSeen.ts";
import { useUi } from "../../state/ui.ts";

/** The open thread is being looked at: everything in it counts as seen, live. */
export function useMarkSeen(): void {
  const threadId = useUi((s) => (s.view === "thread" ? s.selectedThreadId : null));
  const count = useModel((s) => (threadId === null ? 0 : activityCount(s.model, threadId)));
  useEffect(() => {
    if (threadId !== null) markSeen(threadId, count);
  }, [threadId, count]);
}
