import { selectProjects } from "@tide/client";
import { PROVIDER_LABELS, PROVIDERS } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { providerStatus, useProviderRoster } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { Logo } from "../shell/Logo.tsx";
import { NewThreadPopover } from "../shell/NewThreadPopover.tsx";
import { Button } from "../ui/Button.tsx";
import styles from "./MissionControl.module.css";

function Row({
  done,
  step,
  label,
  hint,
  action,
}: {
  done: boolean;
  step: string;
  label: string;
  hint: string;
  action: React.ReactNode;
}) {
  return (
    <li className={styles.checkRow} data-done={done ? "true" : "false"} aria-label={`${step} ${label}`}>
      <span className={styles.checkMark} aria-hidden="true">
        {done ? "✓" : step}
      </span>
      <span className={styles.checkBody}>
        <span>{label}</span>
        <span className={styles.checkHint}>{hint}</span>
      </span>
      <span className={styles.checkAction}>{action}</span>
    </li>
  );
}

/**
 * What the first run looks like: the mark, one sentence, and the three things
 * that have to be true before a thread can run. Every row reads its state from
 * the live model / harness roster, so the checklist is never aspirational.
 */
export function MissionEmpty() {
  const model = useModel((s) => s.model);
  const { providers, loading, error } = useProviderRoster();
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);
  const railCollapsed = useUi((s) => s.railCollapsed);
  const toggleRail = useUi((s) => s.toggleRail);
  const showSettings = useUi((s) => s.showSettings);
  const setSettingsSection = useUi((s) => s.setSettingsSection);

  const projects = selectProjects(model);
  const firstProject = projects[0];
  const ready = loading
    ? []
    : PROVIDERS.filter((kind) => {
        const status = providerStatus(providers, kind);
        return status?.installed === true && status.loggedIn === true;
      });
  const harnessHint = loading
    ? "Checking harnesses…"
    : error
      ? `Could not reach the server: ${error}`
      : ready.length > 0
        ? `Ready: ${ready.map((kind) => PROVIDER_LABELS[kind]).join(", ")}`
        : "None of the four are logged in yet.";

  const addRepository = (): void => {
    if (railCollapsed) toggleRail();
    setNewProjectOpen(true);
  };

  return (
    <div className={styles.emptyState}>
      <Logo size={40} />
      <h2 className={styles.wordmark}>Tide</h2>
      <p className={styles.tagline}>Threads on any coding harness, each on its own worktree.</p>
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
          action={<Button onClick={addRepository}>Add repository</Button>}
        />
        <Row
          done={ready.length > 0}
          step="2"
          label="Log in to a harness"
          hint={harnessHint}
          action={
            <Button
              onClick={() => {
                setSettingsSection("providers");
                showSettings();
              }}
            >
              Providers
            </Button>
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
    </div>
  );
}
