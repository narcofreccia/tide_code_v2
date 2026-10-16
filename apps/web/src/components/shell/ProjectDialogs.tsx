import { archiveProject, renameProject } from "../../lib/projectActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ConfirmDialog, PromptDialog } from "../ui/Dialog.tsx";

/**
 * Rename / archive for a project, raised from the rail's context menu through
 * `ui.projectDialog`. Mission Control's project card keeps its own copies for now.
 */
export function ProjectDialogHost() {
  const dialog = useUi((s) => s.projectDialog);
  const setProjectDialog = useUi((s) => s.setProjectDialog);
  const project = useModel((s) => (dialog ? s.model.projects[dialog.projectId] : undefined));
  if (!dialog || !project) return null;
  const close = (): void => setProjectDialog(null);
  if (dialog.kind === "rename") {
    return (
      <PromptDialog
        title="Rename project"
        label="Project name"
        initial={project.title}
        confirmLabel="Rename"
        onCancel={close}
        onSubmit={(title) => {
          close();
          if (title !== project.title) renameProject(project.id, title);
        }}
      />
    );
  }
  return (
    <ConfirmDialog
      title="Archive project"
      body={
        <>
          Archive <strong>{project.title}</strong>? It leaves Mission Control and the rail. Its threads, worktrees and
          branches are left as they are.
        </>
      }
      confirmLabel="Archive"
      onCancel={close}
      onConfirm={() => {
        close();
        archiveProject(project.id);
      }}
    />
  );
}
