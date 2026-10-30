import type { ReadModel, Thread } from "@tide/contracts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { createChild, deleteNeedsConfirm, isEmptyThread, requestArchive, requestDelete, updateThread } from "../../lib/threadActions.ts";
import { snoozeThread, tomorrowMorning } from "../../lib/turnActions.ts";
import { runInThreadTerminal } from "../../lib/openInTerminal.ts";
import { EDITOR_LABELS, editorBlockedReason, editorUrl, launchEditorUrl, threadEditorTarget, type EditorApp } from "../../lib/openInEditor.ts";
import { useUi } from "../../state/ui.ts";
import type { MenuItem } from "../ui/Menu.tsx";
import { copyItems, latestSettledTurnId, settleItems } from "../shell/railMenus.ts";
import { addressThreadPrComments } from "../prs/prActions.ts";

/** "Link a PR…" always (relinking replaces it); "Address review comments" when the open PR has comments. */
export function prItems(thread: Thread): MenuItem[] {
  const pr = thread.pr;
  const items: MenuItem[] = [
    {
      label: pr ? "Link a different PR…" : "Link a PR…",
      separatorBefore: true,
      onSelect: () => useUi.getState().setLinkPrThread(thread.id),
    },
  ];
  if (pr && pr.state === "open" && (pr.comments ?? 0) > 0) {
    items.push({ label: "Address review comments", onSelect: () => void addressThreadPrComments(thread) });
  }
  if (pr) items.push({ label: `Open PR #${pr.number} in Pull requests`, onSelect: () => useUi.getState().showPrs(thread.projectId) });
  return items;
}

const HOUR = 3_600_000;

/** "Open in VS Code" / "Open in Cursor": local folders directly, remote ones over Remote-SSH. */
export function editorItems(model: ReadModel, thread: Thread): MenuItem[] {
  const target = threadEditorTarget(model, thread);
  const blocked = editorBlockedReason(target);
  return (["vscode", "cursor"] as EditorApp[]).map((app, index) => ({
    label: `Open in ${EDITOR_LABELS[app]}`,
    ...(index === 0 ? { separatorBefore: true } : {}),
    disabled: blocked !== undefined,
    ...(blocked === undefined ? {} : { hint: blocked }),
    onSelect: () => {
      const url = target === undefined ? undefined : editorUrl(app, target);
      if (url) launchEditorUrl(url);
    },
  }));
}

/** The thread header's More menu: everything that is not Terminal / Fork (those fold in when narrow). */
export function headerMenu(
  model: ReadModel,
  thread: Thread,
  now: number = Date.now(),
  narrow?: { terminal: string | undefined; fork: string | undefined },
): MenuItem[] {
  const ui = useUi.getState();
  const lastTurn = latestSettledTurnId(model, thread.id);
  const decisions = useServerSettings.getState().settings.decisions;
  const autoAllowOff = !decisions.enabled || !decisions.hasKey ? "needs a Jev key" : !decisions.sites.approvals ? "approvals judge is off" : undefined;
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
    ...settleItems(thread),
    {
      label: "Snooze",
      submenu: [
        { label: "1 hour", onSelect: () => snoozeThread(thread.id, now + HOUR) },
        { label: "Until tomorrow 09:00", onSelect: () => snoozeThread(thread.id, tomorrowMorning(now)) },
      ],
    },
    {
      label: "Auto-allow routine approvals (this thread)",
      checked: thread.autoAllowRoutine === true,
      disabled: autoAllowOff !== undefined,
      ...(autoAllowOff !== undefined ? { hint: autoAllowOff } : {}),
      onSelect: () => updateThread(thread.id, { autoAllowRoutine: thread.autoAllowRoutine !== true }),
    },
    ...prItems(thread),
    ...copyItems(thread),
    ...editorItems(model, thread),
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
