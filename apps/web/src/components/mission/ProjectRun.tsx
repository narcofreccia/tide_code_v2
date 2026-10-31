import { previewPort, runSummary, selectRecentThreads } from "@tide/client";
import type { RunServiceState } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useRunProfiles, useRunSession } from "../../state/run.ts";
import { useUi } from "../../state/ui.ts";
import { openPreviewTab } from "../../state/workbench.ts";
import { Pill, type PillTone } from "../ui/Pill.tsx";
import styles from "./ProjectRun.module.css";

const TONE: Record<RunServiceState, PillTone> = {
  starting: "running",
  ready: "ok",
  running: "ok",
  exited: "idle",
  failed: "error",
  external: "needs",
};

/** First listening port of the first service that is up, as a localhost URL. */
function firstUrl(session: ReturnType<typeof useRunSession>): string | undefined {
  for (const status of Object.values(session?.services ?? {})) {
    if (status.state !== "ready" && status.state !== "running") continue;
    const port = previewPort(status.ports);
    if (port !== undefined) return `http://localhost:${port}`;
  }
  return undefined;
}

/**
 * "Run · 3/5 up" on the project card. Click opens the project's latest thread with the
 * workbench split on Preview; with no thread (or no profile yet) it opens Settings › Projects.
 */
export function ProjectRun({ projectId }: { projectId: string }) {
  const model = useModel((s) => s.model);
  const { repos } = useRunProfiles(projectId);
  const session = useRunSession(projectId);
  const hasProfile = repos.some((r) => r.profile !== undefined);
  const summary = session === undefined ? undefined : runSummary(session);
  const open = (): void => {
    const ui = useUi.getState();
    const thread = hasProfile ? selectRecentThreads(model, projectId, 1)[0] : undefined;
    if (thread === undefined) {
      ui.selectProject(projectId);
      ui.openSettings("projects");
      return;
    }
    ui.selectThread(thread.id);
    ui.setFocusMode("split");
    const url = firstUrl(session);
    if (url !== undefined) openPreviewTab(thread.id, url);
  };

  if (!hasProfile) {
    return (
      <button type="button" className={styles.chip} onClick={open} title="Set up how this project's repos start together">
        <span className={styles.quiet}>Run · set up</span>
      </button>
    );
  }
  const total = summary?.total ?? 0;
  const up = summary?.up ?? 0;
  const tone: PillTone = summary?.worst === undefined ? "muted" : TONE[summary.worst as RunServiceState];
  return (
    <button type="button" className={styles.chip} onClick={open} title="Open the run stack preview">
      <Pill tone={tone}>{total === 0 ? "Run · stopped" : `Run · ${up}/${total} up`}</Pill>
    </button>
  );
}
