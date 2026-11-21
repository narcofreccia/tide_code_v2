import { selectProjects } from "@tide/client";
import type { ProviderStatusDto, ReadModel } from "@tide/contracts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { installOf, resolveLoginCommand } from "../../lib/providerLogin.ts";
import { isUsable } from "../../lib/preferredProvider.ts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { useWindowReturn } from "../../lib/useWindowReturn.ts";
import { useModel } from "../../state/model.ts";
import { loadProviders, orderedInstances, providerStatus, useProviderRoster, useProvidersStore } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { Logo } from "../shell/Logo.tsx";
import { NewThreadPopover } from "../shell/NewThreadPopover.tsx";
import { SetupStep } from "../settings/ProviderCardSetup.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./MissionControl.module.css";
import local from "./MissionEmpty.module.css";

function Row({
  done,
  step,
  label,
  hint,
  detail,
  action,
}: {
  done: boolean;
  step: string;
  label: string;
  hint: string;
  detail?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <li className={styles.checkRow} data-done={done ? "true" : "false"} aria-label={`${step} ${label}`}>
      <span className={styles.checkMark} aria-hidden="true">
        {done ? <Icon name="check" size={14} /> : step}
      </span>
      <span className={styles.checkBody}>
        <span>{label}</span>
        <span className={styles.checkHint}>{hint}</span>
        {detail}
      </span>
      <span className={styles.checkAction}>{action}</span>
    </li>
  );
}

/** Mission Control mounts `MissionEmpty` while this holds: no repository yet, or no thread yet. */
export function shouldShowGettingStarted(model: ReadModel): boolean {
  return Object.keys(model.projects).length === 0 || Object.keys(model.threads).length === 0;
}

const nameOf = (p: ProviderStatusDto): string => p.label || PROVIDER_LABELS[p.kind];

/** "A", "A or B", "A, B or C" */
function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

export type HarnessStep =
  | { state: "checking" }
  | { state: "error"; error: string }
  | { state: "none-installed"; missing: ProviderStatusDto[] }
  | { state: "logged-out"; installed: ProviderStatusDto[] }
  | { state: "ready"; ready: ProviderStatusDto[] };

/**
 * Where the harness step stands, over every instance the server reports (the bundled kinds and any
 * ACP agent): nothing installed → install one; installed but signed out → log in; one usable → done.
 */
export function harnessStep(providers: readonly ProviderStatusDto[], checking: boolean, error: string | null): HarnessStep {
  if (checking) return { state: "checking" };
  const all = orderedInstances(providers).map((p) => providerStatus(providers, p.id || p.kind) ?? p);
  const ready = all.filter(isUsable);
  if (ready.length > 0) return { state: "ready", ready };
  if (error !== null) return { state: "error", error };
  const installed = all.filter((p) => p.installed);
  if (installed.length > 0) return { state: "logged-out", installed };
  return { state: "none-installed", missing: all };
}

function stepCopy(step: HarnessStep): { label: string; hint: string } {
  switch (step.state) {
    case "checking":
      return { label: "Set up a harness", hint: "Checking harnesses…" };
    case "error":
      return { label: "Set up a harness", hint: `Could not reach the server: ${step.error}` };
    case "ready":
      return { label: "Set up a harness", hint: `Ready: ${step.ready.map(nameOf).join(", ")}` };
    case "logged-out":
      return {
        label: `Log in to ${joinOr(step.installed.map(nameOf))}`,
        hint: "Installed but signed out. Run the login command in your terminal, then come back here.",
      };
    case "none-installed": {
      const any = step.missing.some((p) => installOf(p) !== undefined);
      return {
        label: "Install a harness",
        hint: any
          ? "None is installed yet. Install one in your terminal, then come back here."
          : "None is installed yet. Providers lists what each one needs.",
      };
    }
  }
}

function StepDetail({ step }: { step: HarnessStep }) {
  if (step.state === "none-installed") {
    const rows = step.missing.flatMap((p) => {
      const install = installOf(p);
      return install === undefined ? [] : [{ p, install }];
    });
    if (rows.length === 0) return null;
    return (
      <ul className={local.fixes} aria-label="Install a harness">
        {rows.map(({ p, install }) => (
          <li key={p.id || p.kind} className={local.fix}>
            <span className={local.fixName}>{nameOf(p)}</span>
            <SetupStep name={nameOf(p)} command={install.command} url={install.url} what="install" />
          </li>
        ))}
      </ul>
    );
  }
  if (step.state === "logged-out") {
    return (
      <ul className={local.fixes} aria-label="Log in to a harness">
        {step.installed.map((p) => {
          const command = resolveLoginCommand(p);
          return (
            <li key={p.id || p.kind} className={local.fix}>
              <span className={local.fixName}>{nameOf(p)}</span>
              {command === undefined ? (
                <span className={local.fixNote}>{p.hint ?? "Log in from its own CLI"}</span>
              ) : (
                <SetupStep name={nameOf(p)} command={command} what="login" />
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return null;
}

/**
 * While the harness step is open, coming back to the window re-reads the roster (bypassing the
 * server's status cache): the user installed or logged in from their own terminal. The listeners
 * are removed as soon as a harness is usable.
 */
function useRecheckOnReturn(open: boolean): void {
  useWindowReturn(() => {
    if (!useProvidersStore.getState().loading) loadProviders(true);
  }, open);
}

/**
 * What the first run looks like: the mark, one sentence, and the three things
 * that have to be true before a thread can run. Every row reads its state from
 * the live model / harness roster, so the checklist is never aspirational.
 */
export function MissionEmpty() {
  const model = useModel((s) => s.model);
  const { providers, loading, error } = useProviderRoster();
  const info = useServerInfo();
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);
  const railCollapsed = useUi((s) => s.railCollapsed);
  const toggleRail = useUi((s) => s.toggleRail);
  const showSettings = useUi((s) => s.showSettings);
  const setSettingsSection = useUi((s) => s.setSettingsSection);

  const projects = selectProjects(model);
  const firstProject = projects[0];
  // a refresh keeps the last answer on screen; only the very first read shows "checking"
  const checking = loading && providers.length === 0;
  const step = harnessStep(providers, checking, error);
  const copy = stepCopy(step);
  const harnessDone = step.state === "ready";
  useRecheckOnReturn(!harnessDone && !checking);

  const addRepository = (): void => {
    if (railCollapsed) toggleRail();
    setNewProjectOpen(true);
  };

  // once a repository exists the card shrinks to the checklist and stays until the first thread
  const compact = projects.length > 0;
  const noGit = info?.tools !== undefined && !info.tools.git;

  return (
    <div className={styles.emptyState}>
      {compact ? null : (
        <>
          <Logo size={40} />
          <h2 className={styles.wordmark}>Tide</h2>
          <p className={styles.tagline}>Threads on any coding harness, each on its own worktree.</p>
        </>
      )}
      <ul className={styles.checklist} aria-label="Getting started">
        <Row
          done={projects.length > 0}
          step="1"
          label="Add a repository"
          hint={
            firstProject
              ? `${projects.length} added · ${firstProject.rootPath}`
              : "Point Tide at a git repo; threads get worktrees under it."
          }
          action={
            <Button variant={projects.length === 0 ? "primary" : "ghost"} onClick={addRepository}>
              Add repository
            </Button>
          }
        />
        <Row
          done={harnessDone}
          step="2"
          label={copy.label}
          hint={copy.hint}
          detail={<StepDetail step={step} />}
          action={
            <span className={local.actions}>
              {harnessDone ? null : (
                <Button
                  variant="quiet"
                  disabled={loading}
                  title="Ask the server to check every harness again"
                  onClick={() => loadProviders(true)}
                >
                  {loading && !checking ? "Checking…" : "Refresh"}
                </Button>
              )}
              <Button
                onClick={() => {
                  setSettingsSection("providers");
                  showSettings();
                }}
              >
                Providers
              </Button>
            </span>
          }
        />
        <Row
          done={Object.keys(model.threads).length > 0}
          step="3"
          label="Start a thread"
          hint="Pick a harness, model and whether it runs on its own worktree."
          action={<NewThreadPopover projectId={firstProject?.id} variant="ghost" align="end" />}
        />
      </ul>
      {noGit ? (
        <p className={local.warn} role="note">
          git is not installed on {info.name}; threads cannot use worktrees.
        </p>
      ) : null}
    </div>
  );
}
