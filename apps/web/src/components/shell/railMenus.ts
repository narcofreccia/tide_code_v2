import { selectThreadTurns } from "@tide/client";
import type { Project, ReadModel, Thread } from "@tide/contracts";
import {
  copyText,
  createChild,
  deleteNeedsConfirm,
  isEmptyThread,
  requestArchive,
  requestDelete,
  setAutoSettle,
  setThreadPinned,
  settleThread,
  unarchiveThread,
  unsettleThread,
} from "../../lib/threadActions.ts";
import { openThreadTerminal } from "../../lib/openInTerminal.ts";
import { snoozeThread, tomorrowMorning } from "../../lib/turnActions.ts";
import { useUi } from "../../state/ui.ts";
import type { MenuItem } from "../ui/Menu.tsx";

const HOUR = 3_600_000;
export const NO_SESSION_HINT = "no session yet";

/** The newest turn that finished one way or another: what Fork… starts from. */
export function latestSettledTurnId(model: ReadModel, threadId: string): string | undefined {
  const settled = selectThreadTurns(model, threadId).filter(
    (t) => t.status === "completed" || t.status === "interrupted" || t.status === "error",
  );
  return settled[settled.length - 1]?.id;
}

/** Settle / Unsettle and the per-thread auto-settle opt-out; shared by the rail and the thread header. */
export function settleItems(thread: Thread): MenuItem[] {
  const settled = thread.settledAt !== undefined;
  return [
    settled
      ? { label: "Unsettle", onSelect: () => unsettleThread(thread.id) }
      : { label: "Settle", onSelect: () => settleThread(thread.id) },
    {
      label: "Auto-settle this thread",
      checked: thread.autoSettle !== false,
      onSelect: () => setAutoSettle(thread.id, thread.autoSettle === false),
    },
  ];
}

export function copyItems(thread: Thread): MenuItem[] {
  return [
    { label: "Copy thread ID", onSelect: () => void copyText(thread.id, "thread ID") },
    {
      label: "Copy branch",
      disabled: thread.branch === undefined,
      ...(thread.branch === undefined ? { hint: "no branch" } : {}),
      onSelect: () => {
        if (thread.branch) void copyText(thread.branch, "branch");
      },
    },
  ];
}

/** Right-click / ⋯ on an archived thread: it can only be read, copied from or restored. */
export function archivedThreadMenu(thread: Thread): MenuItem[] {
  return [
    { label: "Open", onSelect: () => useUi.getState().selectThread(thread.id) },
    { label: "Restore", onSelect: () => unarchiveThread(thread.id) },
    ...copyItems(thread),
    { label: "Delete…", danger: true, separatorBefore: true, onSelect: () => requestDelete(thread) },
  ];
}

/** Right-click / ⋯ on a live thread in the rail. */
export function threadMenu(
  model: ReadModel,
  thread: Thread,
  startRename: () => void,
  now: number = Date.now(),
): MenuItem[] {
  if (thread.archivedAt !== undefined) return archivedThreadMenu(thread);
  const ui = useUi.getState();
  const forkTurn = latestSettledTurnId(model, thread.id);
  const hasSession = thread.nativeSessionId !== undefined;
  const empty = isEmptyThread(thread.id);
  return [
    { label: "Open", onSelect: () => ui.selectThread(thread.id) },
    { label: "Rename…", onSelect: startRename },
    { label: thread.pinned ? "Unpin" : "Pin", onSelect: () => setThreadPinned(thread.id, !thread.pinned) },
    ...settleItems(thread),
    {
      label: "Open in terminal",
      disabled: !hasSession,
      ...(hasSession ? {} : { hint: NO_SESSION_HINT }),
      onSelect: () => void openThreadTerminal(thread.id),
    },
    { label: "New child thread", onSelect: () => createChild(thread) },
    {
      label: "Fork…",
      disabled: forkTurn === undefined,
      ...(forkTurn === undefined ? { hint: "no finished turn" } : {}),
      onSelect: () => {
        if (forkTurn) ui.setThreadDialog({ kind: "fork", threadId: thread.id, turnId: forkTurn });
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
    ...(empty ? [] : [{ label: "Archive…", danger: true, onSelect: () => requestArchive(thread) }]),
    { label: deleteNeedsConfirm(thread.id) ? "Delete…" : "Delete", danger: true, onSelect: () => requestDelete(thread) },
  ];
}

/** Right-click / ⋯ on a project row. */
export function projectMenu(project: Project): MenuItem[] {
  const ui = useUi.getState();
  return [
    { label: "New thread…", onSelect: () => ui.openNewThread({ projectId: project.id }) },
    { label: "New Experts session…", onSelect: () => ui.setNewExpertsProject(project.id) },
    { label: "Rename…", onSelect: () => ui.setProjectDialog({ kind: "rename", projectId: project.id }) },
    { label: "Project icon…", onSelect: () => ui.setProjectDialog({ kind: "icon", projectId: project.id }) },
    { label: "Linked repositories…", onSelect: () => ui.setLinksProject(project.id) },
    { label: "Copy path", onSelect: () => void copyText(project.rootPath, "path") },
    {
      label: "Archive project…",
      separatorBefore: true,
      danger: true,
      onSelect: () => ui.setProjectDialog({ kind: "archive", projectId: project.id }),
    },
  ];
}
