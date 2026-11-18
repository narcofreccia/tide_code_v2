import { create } from "zustand";
import type { QuotaScope } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useProjectDeviceLimit, useThreadDeviceLimit } from "../../state/deviceAccess.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { QuotaEditor } from "./QuotaEditor.tsx";

interface QuotaDialogState {
  target: { scope: QuotaScope; id: string } | null;
  open: (scope: QuotaScope, id: string) => void;
  close: () => void;
}

/** Which scope's quota the dialog edits ("Usage quota…" in the thread menu, "Edit quota" elsewhere). */
export const useQuotaDialog = create<QuotaDialogState>((set) => ({
  target: null,
  open: (scope, id) => set({ target: { scope, id } }),
  close: () => set({ target: null }),
}));

export function openQuotaEditor(scope: QuotaScope, id: string): void {
  useQuotaDialog.getState().open(scope, id);
}

function QuotaDialog({ scope, id, onClose }: { scope: QuotaScope; id: string; onClose: () => void }) {
  const entity = useModel((s) => (scope === "project" ? s.model.projects[id] : s.model.threads[id]));
  // R19: changing a quota needs full access on the machine that owns it
  const threadLimit = useThreadDeviceLimit(scope === "thread" ? id : undefined);
  const projectLimit = useProjectDeviceLimit(scope === "project" ? id : undefined);
  if (entity === undefined) return null;
  return (
    <Dialog title={scope === "project" ? `Usage quota of ${entity.title}` : `Usage quota of this thread`} onCancel={onClose} size="md">
      <QuotaEditor scope={scope} entity={entity} limit={scope === "thread" ? threadLimit : projectLimit} startOn onDone={onClose} />
    </Dialog>
  );
}

/** Mounted once by the app shell, beside the thread dialogs. */
export function QuotaDialogHost() {
  const target = useQuotaDialog((s) => s.target);
  const close = useQuotaDialog((s) => s.close);
  if (target === null) return null;
  return <QuotaDialog key={`${target.scope}:${target.id}`} scope={target.scope} id={target.id} onClose={close} />;
}
