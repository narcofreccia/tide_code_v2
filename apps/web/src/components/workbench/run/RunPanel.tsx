import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { RunPlan, RunProfileSource, RunRepo, RunSession, Thread } from "@tide/contracts";
import { runSummary, stackServices, type StackService } from "@tide/client";
import { useModel } from "../../../state/model.ts";
import {
  loadProfiles,
  planStack,
  rescanRepo,
  setSelectionDebounced,
  stopStack,
  useRun,
  useRunProfiles,
  useRunSession,
} from "../../../state/run.ts";
import { useUi } from "../../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Pill } from "../../ui/Pill.tsx";
import { LAYER_ATTR } from "../../ui/useAnchoredPanel.ts";
import { PlanPreviewDialog } from "./PlanPreviewDialog.tsx";
import { RunRow } from "./RunRow.tsx";
import { rootLabel, StackHeader } from "./StackHeader.tsx";
import styles from "./Run.module.css";

const NO_PINS: Record<string, number> = {};

export const NO_PROFILES = "Tide could not detect how to run this repo.";
export const RUN_UNSUPPORTED =
  "Run stack needs a newer tide-server on this machine (restart the desktop app / update the server).";

const SOURCE_TITLE: Record<RunProfileSource, string> = {
  quickstart: "from QUICKSTART.md",
  manifest: "scanned from the repo's manifests",
  model: "written by the model",
  user: "edited by you",
};

/** Every repo, rescanned one after the other (manifests, or the model). */
async function rescanAll(projectId: string, repos: RunRepo[], useModelScan: boolean): Promise<void> {
  if (repos.length === 0) {
    await rescanRepo(projectId, "root", useModelScan);
    return;
  }
  for (const repo of repos) await rescanRepo(projectId, repo.repoId, useModelScan);
}

function RepoGroup({
  repo,
  children,
}: {
  repo: RunRepo;
  children: React.ReactNode;
}) {
  const missing = repo.profile === undefined && repo.error !== undefined;
  return (
    <section className={`${styles.group} ${missing ? styles.missing : ""}`} aria-label={repo.label}>
      <div className={styles.groupLabel}>
        <span className={styles.groupName} title={repo.path}>
          {repo.label}
        </span>
        {repo.profile ? (
          <Pill size="sm" title={SOURCE_TITLE[repo.profile.source]}>
            {repo.profile.source}
          </Pill>
        ) : null}
        {repo.stale ? (
          <Pill size="sm" tone="needs" title="The manifests changed since this profile was made; rescan">
            stale
          </Pill>
        ) : null}
      </div>
      {repo.error === undefined ? null : <p className={styles.repoError}>{repo.error}</p>}
      {repo.profile === undefined && repo.error === undefined ? <p className={styles.note}>No run profile yet; rescan.</p> : null}
      {children}
    </section>
  );
}

function EmptyProfiles({ projectId, repos }: { projectId: string; repos: RunRepo[] }) {
  const [busy, setBusy] = useState(false);
  const scan = (useModelScan: boolean): void => {
    setBusy(true);
    void rescanAll(projectId, repos, useModelScan).finally(() => setBusy(false));
  };
  return (
    <div className={styles.empty}>
      <p className={styles.note}>{NO_PROFILES}</p>
      <span className={styles.emptyActions}>
        <Button variant="ghost" disabled={busy} onClick={() => scan(false)}>
          Scan
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => scan(true)}>
          Ask the model
        </Button>
        <Button variant="quiet" onClick={() => useUi.getState().openSettings("projects")}>
          Open run settings
        </Button>
      </span>
    </div>
  );
}

const LAUNCHED = new Set(["starting", "ready", "running"]);

/**
 * The branch pill: what a running stack's root repo runs from, else what this thread would run
 * (its worktree, or the main checkout); nothing outside a thread with nothing running.
 */
export function stackRoot(session: RunSession | undefined, thread: Pick<Thread, "worktreePath" | "branch"> | undefined): string | undefined {
  const running = session !== undefined && Object.values(session.services).some((s) => LAUNCHED.has(s.state));
  if (running) return rootLabel(session.worktree);
  if (thread === undefined) return undefined;
  return rootLabel(thread.worktreePath === undefined ? undefined : { path: thread.worktreePath, branch: thread.branch });
}

interface OpenPlan {
  plan: RunPlan;
  selected: string[];
  pins: Record<string, number>;
}

/**
 * R13: the project's stack — one row per service of every repo (root + links). Fills the Preview
 * empty state, or sits as a collapsible strip above a live preview (`variant="strip"`).
 */
export function RunPanel({
  projectId,
  threadId,
  variant = "pane",
}: {
  projectId: string;
  threadId?: string;
  variant?: "pane" | "strip";
}) {
  const project = useModel((s) => s.model.projects[projectId]);
  const thread = useModel((s) => (threadId === undefined ? undefined : s.model.threads[threadId]));
  const { repos, loading, loaded, error, unsupported } = useRunProfiles(projectId);
  const session = useRunSession(projectId);
  const lastPlan = useRun((s) => s.plans[projectId]);
  const pending = useRun((s) => s.pending[projectId]);
  const [collapsed, setCollapsed] = useState(variant === "strip");
  const [open, setOpen] = useState<OpenPlan | undefined>(undefined);
  const [planning, setPlanning] = useState(false);

  const services = useMemo(() => stackServices(repos, project), [repos, project]);
  const selected = useMemo(
    () => pending ?? services.filter((s) => s.selected).map((s) => s.key),
    [pending, services],
  );
  const summary = runSummary(session);
  const pins = project?.runStack?.pins ?? NO_PINS;

  const onToggle = (key: string, on: boolean): void => {
    const next = on ? [...selected.filter((k) => k !== key), key] : selected.filter((k) => k !== key);
    setSelectionDebounced(projectId, next);
  };

  const onStart = (): void => {
    setPlanning(true);
    void planStack(projectId, { ...(threadId === undefined ? {} : { threadId }), selected, pins }).then((plan) => {
      setPlanning(false);
      if (plan) setOpen({ plan, selected, pins });
    });
  };

  const byRepo = (repo: RunRepo): StackService[] => services.filter((s) => s.repoId === repo.repoId);
  const hasServices = services.length > 0;

  const body = (() => {
    if (!loaded && loading) return <p className={styles.note}>Loading run profiles…</p>;
    if (unsupported) return <p className={styles.note}>{RUN_UNSUPPORTED}</p>;
    if (error !== undefined && repos.length === 0) return <p className={styles.loadError}>Could not load run profiles: {error}</p>;
    if (!hasServices && repos.every((r) => r.error === undefined)) return <EmptyProfiles projectId={projectId} repos={repos} />;
    return repos.map((repo) => (
      <RepoGroup key={repo.repoId} repo={repo}>
        {byRepo(repo).map((item) => (
          <RunRow
            key={item.key}
            projectId={projectId}
            threadId={threadId}
            item={item}
            selected={selected.includes(item.key)}
            status={session?.services[item.key]}
            planRow={(session?.plan ?? lastPlan)?.rows.find((r) => r.key === item.key)}
            rootPath={(session?.plan ?? lastPlan)?.rootPath}
            onToggle={onToggle}
          />
        ))}
      </RepoGroup>
    ));
  })();

  return (
    <div className={`${styles.panel} ${variant === "strip" ? styles.strip : styles.pane}`} aria-label="Run stack">
      <StackHeader
        summary={summary}
        selectedCount={selected.length}
        root={stackRoot(session, thread)}
        starting={planning}
        canStart={!unsupported}
        {...(variant === "strip" ? { collapsed, onToggleCollapsed: () => setCollapsed((c) => !c) } : {})}
        onStart={onStart}
        onStopAll={() => void stopStack(projectId)}
        onRefresh={() => void loadProfiles(projectId, true)}
        onRescan={() => void rescanAll(projectId, repos, false)}
      />
      {variant === "strip" && collapsed ? null : body}
      {open && typeof document !== "undefined"
        ? createPortal(
            // a layer: a Popover hosting this panel stays open while the dialog is used
            <div {...{ [LAYER_ATTR]: "" }}>
              <PlanPreviewDialog
                projectId={projectId}
                threadId={threadId}
                initialPlan={open.plan}
                initialSelected={open.selected}
                initialPins={open.pins}
                services={services}
                repos={repos}
                onClose={() => setOpen(undefined)}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
