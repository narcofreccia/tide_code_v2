import type { LinkAccess } from "@tide/contracts";
import { call, dispatch } from "../state/model.ts";
import { showToast } from "../state/toast.ts";
import { invalidateThread } from "../state/vcs.ts";

/** The fields the links editor collects for one linked repository. */
export interface LinkDraft {
  path: string;
  label: string;
  note: string;
  access: LinkAccess;
}

function report(what: string, error: unknown): void {
  showToast(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** Links a secondary repository to the project; the label defaults to the folder name. */
export async function addProjectLink(projectId: string, draft: LinkDraft): Promise<void> {
  try {
    await dispatch({
      type: "project.link.add",
      projectId,
      path: draft.path.trim(),
      label: draft.label.trim(),
      access: draft.access,
      ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
    });
  } catch (error) {
    report("Linking the repository", error);
    throw error;
  }
}

/** Edits one link in place. Note is always sent so clearing it sticks. */
export async function updateProjectLink(
  projectId: string,
  linkId: string,
  patch: { label?: string; note?: string; access?: LinkAccess },
): Promise<void> {
  try {
    await dispatch({
      type: "project.link.update",
      projectId,
      linkId,
      ...(patch.label === undefined ? {} : { label: patch.label.trim() }),
      ...(patch.note === undefined ? {} : { note: patch.note.trim() }),
      ...(patch.access === undefined ? {} : { access: patch.access }),
    });
  } catch (error) {
    report("Updating the link", error);
    throw error;
  }
}

export function removeProjectLink(projectId: string, linkId: string): void {
  void dispatch({ type: "project.link.remove", projectId, linkId }).catch((error: unknown) =>
    report("Removing the link", error),
  );
}

// ---- linked-repo changes (Workbench › Changes) ----

/** Discards a linked repository's working-tree changes for this thread. */
export async function revertLinkedChanges(threadId: string, linkId: string, files?: string[]): Promise<void> {
  try {
    const result = await call("vcs.linkedRevert", {
      threadId,
      linkId,
      ...(files === undefined ? {} : { files }),
    });
    invalidateThread(threadId);
    const count = result.reverted.length;
    showToast(`Reverted ${count} file${count === 1 ? "" : "s"} in the linked repository`);
  } catch (error) {
    report("Reverting linked changes", error);
  }
}
