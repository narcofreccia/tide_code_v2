import { useState } from "react";
import { selectPrCounts, selectProjectLinks, selectProjectTotals, selectRecentThreads } from "@tide/client";
import type { Project } from "@tide/contracts";
import { threadHarnessLabel } from "../../lib/vocab.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { archiveProject, renameProject } from "../../lib/projectActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { NewThreadPopover } from "../shell/NewThreadPopover.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ProjectIcon } from "../ui/ProjectIcon.tsx";
import { ConfirmDialog, PromptDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Popover } from "../ui/Popover.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { CostSummary } from "./CostSummary.tsx";
import { ThreadTags } from "./ThreadTags.tsx";
import { ProjectExperts } from "./ProjectExperts.tsx";
import { ProjectAutomations } from "./ProjectAutomations.tsx";
import { ProjectRun } from "./ProjectRun.tsx";
import styles from "./MissionControl.module.css";
import { plural } from "../../lib/format.ts";

type ProjectDialog = "rename" | "archive" | null;

const PATH_MAX = 44;

/** `/Users/me/dev/…/tide_code_v2`: keeps the root and the repo folder, drops the middle. */
export function middleEllipsis(path: string, max = PATH_MAX): string {
  if (path.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${path.slice(0, max - 1 - tail)}…${path.slice(path.length - tail)}`;
}

/** `more` on the card: rename, archive (confirmed). */
function ProjectMenu({ project, onOpen }: { project: Project; onOpen: (dialog: ProjectDialog) => void }) {
  return (
    <Popover
      label={<Icon name="more" label={`More actions for ${project.title}`} />}
      title={`More actions for ${project.title}`}
      variant="quiet"
      align="end"
    >
      {(close) => (
        <div className={styles.menu}>
          <Button
            variant="quiet"
            onClick={() => {
              close();
              onOpen("rename");
            }}
          >
            Rename…
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              close();
              onOpen("archive");
            }}
          >
            Archive project…
          </Button>
        </div>
      )}
    </Popover>
  );
}

/**
 * One repository: a header (icon, name, path, menu), one meta line, its three most
 * recent threads as rail-density rows, and a footer to start work. Cost and
 * automations sit behind Details. Flat — a hairline card on `--surface`.
 */
export function ProjectCard({ project }: { project: Project }) {
  const providers = useProvidersSnapshot();
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const showAllThreads = useUi((s) => s.showAllThreads);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  const setLinksProject = useUi((s) => s.setLinksProject);
  const [dialog, setDialog] = useState<ProjectDialog>(null);
  const [details, setDetails] = useState(false);
  const totals = selectProjectTotals(model, project.id);
  const prs = selectPrCounts(model, project.id);
  const recent = selectRecentThreads(model, project.id, 3);
  const links = selectProjectLinks(model, project.id);
  const lastActive = recent[0]?.updatedAt;

  return (
    <article className={styles.card} aria-label={`Project ${project.title}`}>
      <div className={styles.cardHead}>
        <ProjectIcon project={project} />
        <h3 className={styles.cardTitle}>{project.title}</h3>
        <span className={styles.path} title={project.rootPath}>
          {middleEllipsis(project.rootPath)}
        </span>
        <ProjectMenu project={project} onOpen={setDialog} />
      </div>

      <div className={styles.counts}>
        <span className={styles.facts}>
          <span>{plural(totals.threads, "thread")}</span>
          {totals.running > 0 ? <span className={styles.factRunning}>{totals.running} running</span> : null}
          {totals.needsYou > 0 ? <span className={styles.factNeeds}>{totals.needsYou} needs you</span> : null}
          {lastActive === undefined ? null : (
            <span title={new Date(lastActive).toLocaleString()}>active {relativeTime(lastActive)}</span>
          )}
        </span>
        {prs.open > 0 ? (
          <button
            type="button"
            className={styles.prLink}
            onClick={() => useUi.getState().showPrs(project.id)}
            title={`Pull requests in ${project.title}`}
            aria-label={`${prs.open} open pull requests in ${project.title}`}
          >
            <Pill tone="running">
              <Icon name="pullRequest" size={12} />
              {prs.open} open
            </Pill>
          </button>
        ) : null}
        {prs.landed > 0 ? (
          <Pill tone="ok">
            <Icon name="check" size={12} />
            {prs.landed} merged
          </Pill>
        ) : null}
        <span className={styles.pushRight} />
        <ProjectRun projectId={project.id} />
        <Button variant="quiet" onClick={() => setLinksProject(project.id)} title="Linked repositories">
          {links.length === 0 ? "Link a repo" : `Links · ${links.length}`}
        </Button>
        <button type="button" className={styles.details} aria-expanded={details} onClick={() => setDetails(!details)}>
          <Icon name="chevronRight" size={12} className={`${details ? styles.chevronOpen : styles.chevron}`} />
          Details
        </button>
      </div>
      {details ? (
        <div className={styles.detailsBody}>
          <div className={styles.costRow}>
            <CostSummary
              todayUsd={totals.costTodayUsd}
              lifetimeUsd={totals.costLifetimeUsd}
              byProvider={totals.costByProvider}
            />
          </div>
          <ProjectAutomations projectId={project.id} />
          <div className={styles.costRow}>
            <Button
              onClick={() => useUi.getState().openNewThread({ projectId: project.id, tab: "team" })}
              title="Start a multi-harness team run on this project"
            >
              Team run
            </Button>
          </div>
        </div>
      ) : null}

      {recent.length === 0 ? (
        <p className={styles.cardEmpty}>No threads. Each thread works on its own branch.</p>
      ) : (
        <ul className={styles.recent}>
          {recent.map((thread) => (
            <li key={thread.id}>
              <button type="button" className={styles.recentRow} onClick={() => selectThread(thread.id)}>
                <span className={styles.rowGlyph}>
                  <ThreadGlyph thread={thread} />
                </span>
                <span className={styles.rowTitle}>{thread.title}</span>
                <ThreadTags thread={thread} />
                {thread.interrupting === true ? <span className={styles.interrupting}>interrupting…</span> : null}
                <span className={styles.rowMeta}>
                  <span>{threadHarnessLabel(providers, thread)}</span>
                  <span className={styles.time}>{relativeTime(thread.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <ProjectExperts projectId={project.id} projectTitle={project.title} />

      <div className={styles.actions}>
        <NewThreadPopover projectId={project.id} variant="primary" />
        <Button variant="quiet" onClick={() => setNewExpertsProject(project.id)}>
          Experts
        </Button>
        <Button
          variant="quiet"
          className={styles.pushRight}
          onClick={() => showAllThreads(project.id)}
          aria-label={`All threads in ${project.title}`}
        >
          All threads
          <Icon name="chevronRight" size={12} />
        </Button>
      </div>

      {dialog === "rename" ? (
        <PromptDialog
          title="Rename project"
          label="Project name"
          initial={project.title}
          confirmLabel="Rename"
          onCancel={() => setDialog(null)}
          onSubmit={(title) => {
            setDialog(null);
            if (title !== project.title) renameProject(project.id, title);
          }}
        />
      ) : null}
      {dialog === "archive" ? (
        <ConfirmDialog
          title="Archive project"
          body={
            <>
              Archive <strong>{project.title}</strong>? It leaves Mission Control and the rail. Its threads, worktrees
              and branches are left as they are.
            </>
          }
          confirmLabel="Archive"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            archiveProject(project.id);
          }}
        />
      ) : null}
    </article>
  );
}
