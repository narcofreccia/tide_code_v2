import type { ReadModel, Thread } from "@tide/contracts";
import { createChild, deleteNeedsConfirm, isEmptyThread, requestArchive, requestDelete } from "../../lib/threadActions.ts";
import { snoozeThread, tomorrowMorning } from "../../lib/turnActions.ts";
import { runInThreadTerminal } from "../../lib/openInTerminal.ts";
import { useUi } from "../../state/ui.ts";
import type { MenuItem } from "../ui/Menu.tsx";
import { copyItems, latestSettledTurnId } from "../shell/railMenus.ts";

const HOUR = 3_600_000;

/** The thread header's `⋯`: everything that is not Terminal / Fork (those fold in when narrow). */
export function headerMenu(
  model: ReadModel,
  thread: Thread,
  now: number = Date.now(),
  narrow?: { terminal: string | undefined; fork: string | undefined },
): MenuItem[] {
  const ui = useUi.getState();
  const lastTurn = latestSettledTurnId(model, thread.id);
  const folded: MenuItem[] = narrow
    ? [
        {
          label: "Terminal",
          disabled: narrow.terminal === undefined,
          ...(narrow.terminal === undefined ? { hint: "no session yet" } : {}),
          onSelect: () => {
            const command = narrow.terminal;
            if (command) void runInThreadTerminal(thread.id, command);
          },
        },
        {
          label: "Fork",
          disabled: narrow.fork === undefined,
          ...(narrow.fork === undefined ? { hint: "no finished turn" } : {}),
          onSelect: () => {
            if (narrow.fork) ui.setThreadDialog({ kind: "fork", threadId: thread.id, turnId: narrow.fork });
          },
        },
      ]
    : [];
  return [
    ...folded,
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
    {
      label: deleteNeedsConfirm(thread.id) ? "Delete thread…" : "Delete thread",
      danger: true,
      onSelect: () => requestDelete(thread),
    },
  ];
}
