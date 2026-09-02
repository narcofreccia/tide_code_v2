import { copyTerminalCommand, fetchTerminalCommand } from "./threadActions.ts";
import { createPty, setDrawerOpen, writePty } from "../state/terminals.ts";
import { showToast } from "../state/toast.ts";

const NO_COMMAND = "No harness session to resume yet";

/**
 * Runs a command in a fresh PTY of the thread (the server opens it in the
 * thread's worktree, or the project root when it has none) and reveals the
 * terminal drawer. Falls back to the clipboard when no PTY can be created.
 */
export async function runInThreadTerminal(threadId: string, command: string): Promise<void> {
  const ptyId = await createPty(threadId, 80, 24);
  if (!ptyId) return copyTerminalCommand(command);
  setDrawerOpen(true);
  writePty(ptyId, `${command}\n`);
  return undefined;
}

/**
 * The escape hatch: opens a terminal on the thread's directory and types the
 * harness's own resume command into it.
 */
export async function openThreadTerminal(threadId: string): Promise<void> {
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
  await runInThreadTerminal(threadId, command);
}
