import { useCallback, useEffect, useState } from "react";
import type { Project } from "@tide/contracts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { call } from "../../state/model.ts";
import { envOfProject } from "../../state/environments.ts";
import { showToast } from "../../state/toast.ts";
import { envOpt } from "../fleet/envView.ts";
import { EnvTag } from "../fleet/FleetBits.tsx";
import { Button } from "../ui/Button.tsx";
import { useTicker } from "./useTicker.ts";
import styles from "./RepoMachines.module.css";

type BaseStatus = Awaited<ReturnType<typeof fetchStatus>>;

function fetchStatus(project: Project) {
  return call("vcs.baseStatus", { projectId: project.id, refresh: true }, envOpt(envOfProject(project.id)));
}

/** An older tide-server answers an unknown method with `method-not-found` ("unknown method …"). */
function isUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "method-not-found" || (error instanceof Error && error.message.startsWith("unknown method "));
}

/** "main · ahead 1 · behind 2" (or "main · up to date"). */
export function baseSummary(s: BaseStatus): string {
  if (!s.hasRemote) return `${s.branch} · no remote`;
  const parts = [s.branch];
  if (s.ahead === undefined && s.behind === undefined) parts.push("not fetched");
  else if ((s.ahead ?? 0) === 0 && (s.behind ?? 0) === 0) parts.push("up to date");
  else {
    if ((s.ahead ?? 0) > 0) parts.push(`ahead ${s.ahead}`);
    if ((s.behind ?? 0) > 0) parts.push(`behind ${s.behind}`);
  }
  if (s.dirty) parts.push("dirty");
  return parts.join(" · ");
}

function MachineRow({ project, now }: { project: Project; now: number }) {
  const [status, setStatus] = useState<BaseStatus | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [pulling, setPulling] = useState(false);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchStatus(project));
      setNote(undefined);
    } catch (error) {
      setNote(isUnsupported(error) ? "update this machine to sync" : errorText(error));
    }
  }, [project]);
  // the ticker re-runs this every minute (the server throttles the underlying fetch)
  useEffect(() => {
    void refresh();
  }, [refresh, now]);
  const pull = async (): Promise<void> => {
    setPulling(true);
    try {
      const result = await call("vcs.pullBase", { projectId: project.id }, envOpt(envOfProject(project.id)));
      if (!result.ok) showToast(`Pull failed: ${result.error ?? "could not fast-forward"}`);
      await refresh();
    } catch (error) {
      showToast(`Pull failed: ${isUnsupported(error) ? "this machine's Tide is too old" : errorText(error)}`);
    } finally {
      setPulling(false);
    }
  };
  const unsupported = note === "update this machine to sync";
  return (
    <li className={styles.row}>
      <EnvTag envId={envOfProject(project.id)} />
      <span className={styles.state} title={project.rootPath}>
        {status ? baseSummary(status) : (note ?? "checking…")}
        {status && note ? <span className={styles.note}> · {note}</span> : null}
      </span>
      <Button
        variant="quiet"
        disabled={pulling || unsupported || status?.hasRemote === false}
        onClick={() => void pull()}
        aria-label={`Pull on ${project.title}`}
        title="Fast-forward the base branch to origin"
      >
        {pulling ? "Pulling…" : "Pull"}
      </Button>
      <Button variant="quiet" disabled={pulling} onClick={() => void refresh()} aria-label={`Refresh ${project.title}`} title="Check origin now">
        Refresh
      </Button>
    </li>
  );
}

/** One row per clone of the repo: machine, base branch against origin, Pull. Drawn only for a repo with a remote. */
export function RepoMachines({ projects }: { projects: readonly Project[] }) {
  const now = useTicker(60_000);
  if (!projects.some((p) => p.repo !== undefined)) return null;
  return (
    <ul className={styles.list} aria-label="Machines">
      {projects.map((p) => (
        <MachineRow key={p.id} project={p} now={now} />
      ))}
    </ul>
  );
}
