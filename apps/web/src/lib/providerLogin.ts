import type { ProviderStatusDto } from "@tide/contracts";
import { copyTerminalCommand } from "./threadActions.ts";
import { runInThreadTerminal } from "./openInTerminal.ts";
import { useUi } from "../state/ui.ts";

/** Legacy shape: some drivers only backtick the command in the hint ("Run `claude /login`"). */
export function loginCommand(hint: string | undefined): string | undefined {
  return hint?.match(/`([^`]+)`/)?.[1];
}

/**
 * The command that logs this harness in, or undefined when logging in is not the
 * problem. A harness that is not installed has an *install* hint, never a login
 * command — offering to run it would be a lie. Drivers populate `loginCommand`;
 * the backticked hint is only the fallback for the ones that do not yet.
 */
export function resolveLoginCommand(status: ProviderStatusDto | undefined): string | undefined {
  if (!status || !status.installed || status.loggedIn) return undefined;
  return status.loginCommand ?? loginCommand(status.hint);
}

/** Runs the command in a new terminal of the selected thread, else copies it. */
export async function runOrCopy(command: string): Promise<void> {
  const threadId = useUi.getState().selectedThreadId;
  if (!threadId) return copyTerminalCommand(command);
  return runInThreadTerminal(threadId, command);
}
