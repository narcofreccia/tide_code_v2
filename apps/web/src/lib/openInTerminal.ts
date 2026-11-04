import { copyTerminalCommand, fetchTerminalCommand } from "./threadActions.ts";
import { createPty, ensurePtys, livePurposeTab, setActivePty, setDrawerOpen, writePty, type PtyPurpose } from "../state/terminals.ts";
import { showToast } from "../state/toast.ts";
import { useUi } from "../state/ui.ts";
import { useMobileNav } from "../components/mobile/mobileNav.ts";
import { isPhoneViewport } from "./useViewport.ts";

const NO_COMMAND = "No harness session to resume yet";

/**
 * The drawer lives in the workbench: Chat-only focus has none, so it widens to Split.
 * On a phone the workbench is the Code sheet, so that opens too.
 */
export function revealTerminalDrawer(): void {
  const ui = useUi.getState();
  if (ui.focusMode === "thread") ui.setFocusMode("split");
  setDrawerOpen(true);
  if (isPhoneViewport()) useMobileNav.getState().setCodeOpen(true);
}

/** Terminals are per thread: an action on another thread shows that thread first. */
function showThread(threadId: string): void {
  const ui = useUi.getState();
  if (ui.selectedThreadId !== threadId) ui.selectThread(threadId);
}

const pending = new Map<string, Promise<void>>();

async function run(threadId: string, command: string, purpose: PtyPurpose | undefined): Promise<void> {
  if (purpose !== undefined) {
    // a reload drops client tabs; list the server's first so an existing tab is found
    await ensurePtys(threadId);
    const existing = livePurposeTab(threadId, purpose);
    if (existing) {
      setActivePty(threadId, existing.ptyId);
      revealTerminalDrawer();
      return;
    }
  }
  const ptyId = await createPty(threadId, 80, 24, purpose);
  if (!ptyId) return copyTerminalCommand(command);
  revealTerminalDrawer();
  writePty(ptyId, `${command}\n`);
  return undefined;
}

/**
 * Runs a command in a PTY of the thread (the server opens it in the thread's worktree, or the
 * project root when it has none) and reveals the terminal drawer. A `purpose` tab is reused while
 * it is alive: a second "Terminal" click focuses the resume tab instead of stacking another.
 * Falls back to the clipboard when no PTY can be created.
 */
export function runInThreadTerminal(threadId: string, command: string, options: { purpose?: PtyPurpose } = {}): Promise<void> {
  showThread(threadId);
  const key = options.purpose === undefined ? undefined : `${threadId}:${options.purpose}`;
  const inFlight = key === undefined ? undefined : pending.get(key);
  if (inFlight) return inFlight;
  const job = run(threadId, command, options.purpose);
  if (key === undefined) return job;
  pending.set(key, job);
  return job.finally(() => pending.delete(key));
}

/**
 * The escape hatch: opens a terminal on the thread's directory and types the
 * harness's own resume command into it.
 */
export async function openThreadTerminal(threadId: string): Promise<void> {
  showThread(threadId);
  const existing = livePurposeTab(threadId, "resume");
  if (existing) {
    setActivePty(threadId, existing.ptyId);
    revealTerminalDrawer();
    return;
  }
  let command: string | undefined;
  try {
    command = await fetchTerminalCommand(threadId);
  } catch {
    showToast("Could not resolve the resume command");
    return;
  }
  if (!command) {
    showToast(NO_COMMAND);
    return;
  }
  await runInThreadTerminal(threadId, command, { purpose: "resume" });
}
