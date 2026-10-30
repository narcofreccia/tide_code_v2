import type { Project, ReadModel } from "@tide/contracts";
import { dispatch, useModel, type RouteOptions } from "../state/model.ts";
import { envOfProject } from "../state/environments.ts";
import { showToast } from "../state/toast.ts";
import { useUi } from "../state/ui.ts";
import { dispatchOrToast, errorText } from "./dispatchOrToast.ts";

/** an archived project's Undo stays up long enough to reach for it */
export const ARCHIVE_UNDO_MS = 8000;

export function renameProject(projectId: string, title: string): void {
  dispatchOrToast("Renaming the project", { type: "project.update", projectId, title });
}

/** Brings an archived project (and its threads) back into the rail and Mission Control. */
export function unarchiveProject(projectId: string): void {
  dispatchOrToast("Restoring the project", { type: "project.unarchive", projectId });
}

/** Archives a project, drops any view scoped to it, and offers Undo for a few seconds. */
export function archiveProject(projectId: string): void {
  const title = useModel.getState().model.projects[projectId]?.title ?? "project";
  dispatch({ type: "project.archive", projectId })
    .then(() =>
      showToast(`Archived “${title}”`, { label: "Undo", onClick: () => unarchiveProject(projectId) }, { ms: ARCHIVE_UNDO_MS }),
    )
    .catch((error: unknown) => showToast(`Archiving the project failed: ${errorText(error)}`));
  const ui = useUi.getState();
  if (ui.selectedProjectId === projectId) ui.selectProject(null);
  if (ui.allThreadsProjectId === projectId) ui.showAllThreads(null);
}

/** `/a/b/` and `/a/b` name the same folder. */
function samePath(a: string, b: string): boolean {
  const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return trim(a) === trim(b);
}

/** The archived project at `rootPath` (on `envId`, when both sides know their machine). */
export function archivedProjectAt(model: ReadModel, rootPath: string, envId?: string): Project | undefined {
  return Object.values(model.projects).find((p) => {
    if (p.archivedAt === undefined || !samePath(p.rootPath, rootPath)) return false;
    const owner = envOfProject(p.id);
    return envId === undefined || owner === undefined || owner === envId;
  });
}

/**
 * Adds an existing repository. A path that belongs to an archived project restores that project
 * instead of registering a duplicate. Rejects with the server's error, like `dispatch`.
 */
export async function addProject(title: string, rootPath: string, opts?: RouteOptions): Promise<"created" | "restored"> {
  const archived = archivedProjectAt(useModel.getState().model, rootPath, opts?.envId);
  if (archived !== undefined) {
    await dispatch({ type: "project.unarchive", projectId: archived.id }, opts);
    showToast(`Restored “${archived.title}”`);
    return "restored";
  }
  await dispatch({ type: "project.create", title, rootPath }, opts);
  return "created";
}
