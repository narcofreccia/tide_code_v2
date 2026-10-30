import type { ProjectIcon } from "@tide/contracts";
import { call } from "../state/model.ts";
import { showToast } from "../state/toast.ts";
import { dispatchOrToast, errorText } from "./dispatchOrToast.ts";

export function setProjectIcon(projectId: string, icon: ProjectIcon | null): void {
  dispatchOrToast("Changing the project icon", { type: "project.update", projectId, icon });
}

/** Asks the server to look for a favicon in the project root; applies it when found. */
export async function detectProjectIcon(projectId: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    const { icon } = await call("project.detectIcon", { projectId });
    if (!icon) return false;
    setProjectIcon(projectId, icon);
    return true;
  } catch (error) {
    if (!opts.quiet) showToast(`Detecting the icon failed: ${errorText(error)}`);
    return false;
  }
}

const flagKey = (projectId: string): string => `tide.iconChecked:${projectId}`;

/** One lazy detection per project and browser: flagged whether or not an icon was found. */
export function detectIconOnce(projectId: string): void {
  try {
    if (localStorage.getItem(flagKey(projectId)) !== null) return;
    localStorage.setItem(flagKey(projectId), "1");
  } catch {
    return;
  }
  void detectProjectIcon(projectId, { quiet: true });
}
