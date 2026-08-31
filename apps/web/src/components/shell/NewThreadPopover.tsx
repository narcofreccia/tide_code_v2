import { createThread } from "../../lib/threadActions.ts";
import { ThreadLinkPicker, useLinkChoices } from "./ThreadLinkPicker.tsx";
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
  const linkChoices = useLinkChoices(projectId);
  return (
    <Popover label={label} variant={variant} align={align} disabled={projectId === undefined}>
      {(close) => (
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
              close();
              if (!projectId) return;
              void createThread(projectId, draft.provider, {
                ...(draft.model === "" ? {} : { model: draft.model }),
                ...(draft.mode === undefined ? {} : { mode: draft.mode }),
                useWorktree: draft.useWorktree,
                ...(linkChoices.payload === undefined ? {} : { links: linkChoices.payload }),
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
