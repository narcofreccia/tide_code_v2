import { useUi } from "../state/ui.ts";
import { dispatchOrToast } from "./dispatchOrToast.ts";

export function renameProject(projectId: string, title: string): void {
  dispatchOrToast("Renaming the project", { type: "project.update", projectId, title });
}

/** Archives a project and drops any view scoped to it. */
export function archiveProject(projectId: string): void {
  dispatchOrToast("Archiving the project", { type: "project.archive", projectId });
  const ui = useUi.getState();
  if (ui.selectedProjectId === projectId) ui.selectProject(null);
  if (ui.allThreadsProjectId === projectId) ui.showAllThreads(null);
}
