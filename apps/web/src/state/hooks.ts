import type { Thread } from "@tide/contracts";
import { useModel } from "./model.ts";
import { useUi, type View } from "./ui.ts";

export function useSelectedThread(): Thread | undefined {
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  return useModel((s) => (selectedThreadId ? s.model.threads[selectedThreadId] : undefined));
}

/** What the main view shows, for the top bar breadcrumb and `document.title`. */
export type ViewHeading =
  | { kind: "thread"; thread: Thread; projectTitle: string }
  | { kind: "label"; label: string };

const VIEW_LABELS: Record<View, string> = {
  mission: "Mission Control",
  thread: "Mission Control",
  settings: "Settings",
  experts: "Experts",
  threads: "All threads",
};

/** Derived from `ui.view`: a thread stays selected under Settings, but is not what is shown. */
export function useViewHeading(): ViewHeading {
  const view = useUi((s) => s.view);
  const thread = useSelectedThread();
  const projectTitle = useModel((s) => (thread ? s.model.projects[thread.projectId]?.title : undefined));
  if (view === "thread" && thread) return { kind: "thread", thread, projectTitle: projectTitle ?? "—" };
  return { kind: "label", label: VIEW_LABELS[view] };
}

/**
 * The thread whose state the status bar reports: the open thread, or the one
 * the Experts board's workbench is bound to. None in Mission Control or Settings.
 */
export function useShownThread(): Thread | undefined {
  const view = useUi((s) => s.view);
  const thread = useSelectedThread();
  return view === "thread" || view === "experts" ? thread : undefined;
}

/** Status of the thread's latest turn; stays `requested` until P1 drivers run. */
export function useLatestTurnStatus(thread: Thread | undefined): string | undefined {
  return useModel((s) => (thread?.latestTurnId ? s.model.turns[thread.latestTurnId]?.status : undefined));
}
