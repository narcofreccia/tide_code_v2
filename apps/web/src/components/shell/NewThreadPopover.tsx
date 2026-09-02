import { createThread } from "../../lib/threadActions.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { ThreadLinkPicker, useLinkChoices } from "./ThreadLinkPicker.tsx";
import { ProviderPicker, useThreadDraft } from "../thread/ProviderPicker.tsx";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Popover } from "../ui/Popover.tsx";

/**
 * provider · model · worktree · links, then create. Shared by the rail popover,
 * Mission Control and the ⌘N dialog, so all three ask exactly the same questions.
 */
export function NewThreadFields({ projectId, onDone }: { projectId: string | undefined; onDone: () => void }) {
  const [draft, patch] = useThreadDraft("claude");
  const linkChoices = useLinkChoices(projectId);
  return (
    <>
      <ProviderPicker draft={draft} onChange={patch} />
      <ThreadLinkPicker
        links={linkChoices.links}
        choices={linkChoices.choices}
        onChange={linkChoices.setChoices}
      />
      <Button
        variant="primary"
        onClick={() => {
          onDone();
          if (!projectId) return;
          runOrToast("Creating the thread", () =>
            createThread(projectId, draft.provider, {
              ...(draft.model === "" ? {} : { model: draft.model }),
              ...(draft.mode === undefined ? {} : { mode: draft.mode }),
              useWorktree: draft.useWorktree,
              ...(linkChoices.payload === undefined ? {} : { links: linkChoices.payload }),
            }),
          );
        }}
      >
        Create thread
      </Button>
    </>
  );
}

/** The anchored form the rail and Mission Control open. */
export function NewThreadPopover({
  projectId,
  label = "New thread",
  variant = "primary",
  align = "start",
}: {
  projectId: string | undefined;
  label?: string;
  variant?: "primary" | "ghost" | "quiet";
  align?: "start" | "end";
}) {
  return (
    <Popover label={label} variant={variant} align={align} disabled={projectId === undefined}>
      {(close) => <NewThreadFields projectId={projectId} onDone={close} />}
    </Popover>
  );
}

/** The same form as a modal, raised by `⌘N` and the palette's "New thread…". */
export function NewThreadDialogHost() {
  const projectId = useUi((s) => s.newThreadProjectId);
  const setNewThreadProject = useUi((s) => s.setNewThreadProject);
  if (projectId === null) return null;
  return (
    <Dialog title="New thread" onCancel={() => setNewThreadProject(null)}>
      <NewThreadFields key={projectId} projectId={projectId} onDone={() => setNewThreadProject(null)} />
    </Dialog>
  );
}
