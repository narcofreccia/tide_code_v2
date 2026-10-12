import { useState } from "react";
import { selectPrCounts, selectProjectLinks, selectProjectTotals, selectRecentThreads } from "@tide/client";
import type { Project } from "@tide/contracts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { archiveProject, renameProject } from "../../lib/projectActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { NewThreadPopover } from "../shell/NewThreadPopover.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog, PromptDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Popover } from "../ui/Popover.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { CostSummary } from "./CostSummary.tsx";
import { ProjectExperts } from "./ProjectExperts.tsx";
import styles from "./MissionControl.module.css";

type ProjectDialog = "rename" | "archive" | null;

/** `⋯` on the card: rename, archive (confirmed). */
function ProjectMenu({ project, onOpen }: { project: Project; onOpen: (dialog: ProjectDialog) => void }) {
  return (
    <Popover label="⋯" title={`More actions for ${project.title}`} variant="quiet" align="end">
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
 * One repository: what it costs, what is open and landed on it, its three most
 * recent threads, and the ways to start work. Flat — a hairline box on
 * `--surface`, never a card inside a card.
 */
export function ProjectCard({ project }: { project: Project }) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const showAllThreads = useUi((s) => s.showAllThreads);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  const setLinksProject = useUi((s) => s.setLinksProject);
  const [dialog, setDialog] = useState<ProjectDialog>(null);
  const totals = selectProjectTotals(model, project.id);
  const prs = selectPrCounts(model, project.id);
  const recent = selectRecentThreads(model, project.id, 3);
  const links = selectProjectLinks(model, project.id);

  return (
    <article className={styles.card} aria-label={`Project ${project.title}`}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{project.title}</h3>
        <span className={styles.path} title={project.rootPath}>
          {project.rootPath}
        </span>
        <ProjectMenu project={project} onOpen={setDialog} />
      </div>

      <div className={styles.counts}>
        <span>{totals.threads} threads</span>
        <span>{totals.running} running</span>
        <span>{totals.needsYou} needs you</span>
        {prs.open > 0 ? <Pill>⇡ {prs.open} open</Pill> : null}
        {prs.landed > 0 ? <Pill>✓ {prs.landed} merged</Pill> : null}
        <Button
          variant="link"
          className={styles.pushRight}
          onClick={() => setLinksProject(project.id)}
          title="Linked repositories"
        >
          {links.length === 0 ? "Link a repo" : `Links · ${links.length}`}
        </Button>
      </div>
      <div className={styles.costRow}>
        <CostSummary
          todayUsd={totals.costTodayUsd}
          lifetimeUsd={totals.costLifetimeUsd}
          byProvider={totals.costByProvider}
        />
      </div>

      {recent.length === 0 ? (
        <p className={styles.empty}>No threads yet.</p>
      ) : (
        <ul className={styles.recent}>
          {recent.map((thread) => (
            <li key={thread.id}>
              <button type="button" className={styles.recentRow} onClick={() => selectThread(thread.id)}>
                <ThreadGlyph thread={thread} />
                <span className={styles.title}>{thread.title}</span>
                {thread.interrupting === true ? (
                  <span className={styles.interrupting}>interrupting…</span>
                ) : null}
                <span className={styles.time}>{relativeTime(thread.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <ProjectExperts projectId={project.id} projectTitle={project.title} />

      <div className={styles.actions}>
        <NewThreadPopover projectId={project.id} />
        <Button onClick={() => setNewExpertsProject(project.id)}>Experts</Button>
        <Button
          variant="link"
          className={styles.pushRight}
          onClick={() => showAllThreads(project.id)}
          aria-label={`All threads in ${project.title}`}
        >
          all threads →
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
