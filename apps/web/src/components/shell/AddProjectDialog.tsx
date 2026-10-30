import { useUi } from "../../state/ui.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { AddProjectForm } from "./AddProjectForm.tsx";

/**
 * "Add project" as a dialog: the rail's empty state, the New menu and Mission Control's
 * empty state all raise it through `ui.newProjectOpen`. Settings › Projects keeps the
 * inline form, where there is room for it.
 */
export function AddProjectDialogHost() {
  const open = useUi((s) => s.newProjectOpen);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);
  if (!open) return null;
  const close = (): void => setNewProjectOpen(false);
  return (
    <Dialog title="Add project" onCancel={close}>
      <AddProjectForm variant="dialog" onDone={close} />
    </Dialog>
  );
}
