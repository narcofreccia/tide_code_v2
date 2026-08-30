import type { Thread } from "@tide/contracts";
import { useModel } from "./model.ts";
import { useUi } from "./ui.ts";

export function useSelectedThread(): Thread | undefined {
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  return useModel((s) => (selectedThreadId ? s.model.threads[selectedThreadId] : undefined));
}

/** Status of the thread's latest turn; stays `requested` until P1 drivers run. */
export function useLatestTurnStatus(thread: Thread | undefined): string | undefined {
  return useModel((s) => (thread?.latestTurnId ? s.model.turns[thread.latestTurnId]?.status : undefined));
}
