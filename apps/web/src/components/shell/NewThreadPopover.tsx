import { createThread } from "../../lib/threadActions.ts";
import { ProviderPicker, useThreadDraft } from "../thread/ProviderPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";

/** provider · model · worktree, then create. Shared by the rail and Mission Control. */
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
  const [draft, patch] = useThreadDraft("claude");
  return (
    <Popover label={label} variant={variant} align={align} disabled={projectId === undefined}>
      {(close) => (
        <>
          <ProviderPicker draft={draft} onChange={patch} />
          <Button
            variant="primary"
            onClick={() => {
              close();
              if (!projectId) return;
              void createThread(projectId, draft.provider, {
                ...(draft.model === "" ? {} : { model: draft.model }),
                useWorktree: draft.useWorktree,
              }).catch(() => undefined);
            }}
          >
            Create thread
          </Button>
        </>
      )}
    </Popover>
  );
}
