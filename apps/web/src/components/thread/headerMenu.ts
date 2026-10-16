import type { ReadModel, Thread } from "@tide/contracts";
import { createChild, requestArchive } from "../../lib/threadActions.ts";
import { snoozeThread, tomorrowMorning } from "../../lib/turnActions.ts";
import { useUi } from "../../state/ui.ts";
import type { MenuItem } from "../ui/Menu.tsx";
import { copyItems, latestSettledTurnId } from "../shell/railMenus.ts";

const HOUR = 3_600_000;

/** The thread header's `⋯`: everything that is not Stop / Terminal / Fork. */
export function headerMenu(model: ReadModel, thread: Thread, now: number = Date.now()): MenuItem[] {
  const ui = useUi.getState();
  const lastTurn = latestSettledTurnId(model, thread.id);
  return [
    { label: "New child thread", onSelect: () => createChild(thread) },
    {
      label: "Roll back last turn…",
      disabled: lastTurn === undefined || thread.rollback?.status === "rolling",
      ...(lastTurn === undefined ? { hint: "no finished turn" } : {}),
      onSelect: () => {
        if (lastTurn) ui.setThreadDialog({ kind: "rollback", threadId: thread.id, turnId: lastTurn });
      },
    },
    {
      label: "Snooze",
      submenu: [
        { label: "1 hour", onSelect: () => snoozeThread(thread.id, now + HOUR) },
        { label: "Until tomorrow 09:00", onSelect: () => snoozeThread(thread.id, tomorrowMorning(now)) },
      ],
    },
    ...copyItems(thread),
    {
      label: "Remove worktree…",
      separatorBefore: true,
      disabled: thread.worktreePath === undefined,
      ...(thread.worktreePath === undefined ? { hint: "no worktree" } : {}),
      onSelect: () => ui.setThreadDialog({ kind: "detach", threadId: thread.id }),
    },
    { label: "Archive thread…", danger: true, onSelect: () => requestArchive(thread) },
  ];
}
