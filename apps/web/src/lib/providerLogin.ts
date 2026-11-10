import type { ProviderStatusDto } from "@tide/contracts";
import { copyTerminalCommand } from "./threadActions.ts";
import { runInThreadTerminal } from "./openInTerminal.ts";
import { useUi } from "../state/ui.ts";

/**
 * How to install a harness, from `providers.list` (the server's table, shared with `tide doctor`;
 * an ACP agent's registry page). Read as optional: an older server sends none.
 */
export interface InstallInfo {
  command?: string;
  url?: string;
}

/** The install steps of a harness that is not installed; undefined otherwise. */
export function installOf(status: ProviderStatusDto | undefined): InstallInfo | undefined {
  if (!status || status.installed) return undefined;
  const install = status.install;
  return install !== undefined && (install.command !== undefined || install.url !== undefined) ? install : undefined;
}

export interface HarnessProblem {
  kind: "install" | "login";
  /** "Codex is not logged in" */
  reason: string;
  /** the shell command that fixes it, when there is one */
  command?: string;
  url?: string;
}

/**
 * What stops a thread on this harness from running its first turn, if anything. An unknown status
 * (roster still loading, instance not reported) is not a problem: nothing is blocked on a guess.
 */
export function harnessProblem(status: ProviderStatusDto | undefined, name: string): HarnessProblem | undefined {
  if (!status) return undefined;
  if (!status.installed) {
    const install = installOf(status);
    return {
      kind: "install",
      reason: `${name} is not installed`,
      ...(install?.command === undefined ? {} : { command: install.command }),
      ...(install?.url === undefined ? {} : { url: install.url }),
    };
  }
  if (!status.loggedIn) {
    const command = resolveLoginCommand(status);
    return { kind: "login", reason: `${name} is not logged in`, ...(command === undefined ? {} : { command }) };
  }
  return undefined;
}

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
