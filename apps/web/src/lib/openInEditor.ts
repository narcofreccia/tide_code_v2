import type { ReadModel, Thread } from "@tide/contracts";
import { envOfThread, useEnvironments, type EnvironmentsState } from "../state/environments.ts";
import { envOpt, envSshHost, isLocalEnv } from "../components/fleet/envView.ts";
import { call } from "../state/model.ts";
import { showToast } from "../state/toast.ts";

/**
 * "Open in VS Code / Cursor" for a thread's checkout. Both editors register a URL scheme:
 * `vscode://file/<abs path>` opens a local folder and
 * `vscode://vscode-remote/ssh-remote+<user@host><abs path>` opens it over Remote-SSH.
 * A checkout on another machine with no SSH host configured cannot be opened from here.
 */

export type EditorApp = "vscode" | "cursor";

export const EDITOR_LABELS: Record<EditorApp, string> = { vscode: "VS Code", cursor: "Cursor" };

export interface EditorTarget {
  path: string;
  /** the checkout is on the machine this client runs on */
  local: boolean;
  sshHost?: string | undefined;
}

/** Spaces and the like are escaped; slashes and `@` stay readable. */
function encodePath(path: string): string {
  return encodeURI(path.startsWith("/") ? path : `/${path}`);
}

/** The editor URL, or undefined when the folder is out of reach (remote, no SSH host). */
export function editorUrl(app: EditorApp, target: EditorTarget): string | undefined {
  if (target.path.trim() === "") return undefined;
  const path = encodePath(target.path);
  if (target.local) return `${app}://file${path}`;
  const host = target.sshHost?.trim();
  if (host === undefined || host === "") return undefined;
  return `${app}://vscode-remote/ssh-remote+${host.replace(/\s+/g, "")}${path}`;
}

/** The folder a thread works in: its worktree, else the project's main checkout. */
export function threadFolder(model: ReadModel, thread: Thread): string | undefined {
  return thread.worktreePath ?? model.projects[thread.projectId]?.rootPath;
}

export function threadEditorTarget(
  model: ReadModel,
  thread: Thread,
  state: EnvironmentsState = useEnvironments.getState(),
): EditorTarget | undefined {
  const path = threadFolder(model, thread);
  if (path === undefined) return undefined;
  const envId = envOfThread(thread.id) ?? state.primaryId;
  return { path, local: isLocalEnv(envId, state), sshHost: envSshHost(envId, state) };
}

/** Why the menu item is disabled, or undefined when it can open. */
export function editorBlockedReason(target: EditorTarget | undefined): string | undefined {
  if (target === undefined) return "no folder yet";
  if (target.local) return undefined;
  return target.sshHost === undefined ? "remote machine: set its SSH host in Settings › Environments" : undefined;
}

/** The browser's own handoff: works in a tab, refused silently by the desktop WebView. */
function assignUrl(url: string): void {
  window.location.assign(url);
}

/**
 * Hands the URL to the OS; the page itself stays put. A thread on this machine asks its local
 * server to run the OS opener (the desktop WebView will not navigate to `vscode://`); a remote
 * one, or a failed launch, falls back to the browser handoff and toasts why.
 */
export async function launchEditorUrl(
  url: string,
  options: { threadId?: string } = {},
  state: EnvironmentsState = useEnvironments.getState(),
): Promise<void> {
  const envId = options.threadId === undefined ? state.primaryId : (envOfThread(options.threadId) ?? state.primaryId);
  if (!isLocalEnv(envId, state)) {
    assignUrl(url);
    return;
  }
  let error: string | undefined;
  try {
    const result = await call("workspace.openExternal", { url }, envOpt(envId));
    if (result.ok) return;
    error = result.error;
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  if (error !== undefined && error !== "") showToast(error);
  assignUrl(url);
}
