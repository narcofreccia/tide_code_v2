import { useEffect, useState } from "react";
import { selectExpertsSessions, selectProjectTotals, selectProjects, selectRailGroups } from "@tide/client";
import type { Project, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { useTicker } from "../mission/useTicker.ts";
import { Button } from "../ui/Button.tsx";
import { ProjectIcon } from "../ui/ProjectIcon.tsx";
import { detectIconOnce } from "../../lib/projectIcon.ts";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import { NewThreadPopover } from "./NewThreadPopover.tsx";
import { ExpertsExplainer, ExpertsGroup, sessionThreadIds } from "./ExpertsGroup.tsx";
import { RailThreadRow, parentOf } from "./RailThreadRow.tsx";
import { projectMenu } from "./railMenus.ts";
import { clearEmptyArchived } from "../../lib/threadActions.ts";
import { envOfProject } from "../../state/environments.ts";
import { EnvTag } from "../fleet/FleetBits.tsx";
import { useMultiEnv } from "../fleet/envView.ts";
import styles from "./ProjectTree.module.css";

/** "Working · n" / "Snoozed · n" / "Settled · n" / "Archived · n": collapsed until opened; flat, no nesting. */
function CollapsedGroup({ name, threads, clearable }: { name: string; threads: Thread[]; clearable?: boolean }) {
  const [open, setOpen] = useState(false);
  if (threads.length === 0) return null;
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <button type="button" className={styles.groupToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {name} · {threads.length}
        </button>
        {clearable ? (
          <button
            type="button"
            className={styles.groupClear}
            title="Delete archived threads that have no turns"
            onClick={() => clearEmptyArchived(threads)}
          >
            Clear
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className={styles.threads} aria-label={`${name} threads`}>
          {threads.map((t) => (
            <RailThreadRow key={t.id} thread={t} siblings={[]} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProjectNode({ project }: { project: Project }) {
  const model = useModel((s) => s.model);
  const now = useTicker(60_000);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  const multiEnv = useMultiEnv();
  const workingSection = useServerSettings((s) => s.settings.inbox.workingSection);
  const groups = selectRailGroups(model, project.id, now, { workingSection });
  // threads shown under a session are not listed again at the top
  const claimed = new Set(selectExpertsSessions(model, project.id).flatMap(sessionThreadIds));
  const live = [...groups.pinned, ...groups.threads, ...groups.working, ...groups.snoozed];
  // a pinned parent keeps its children; anything nested under a listed parent is not a root
  const nestable = [...groups.pinned, ...groups.threads];
  const listed = new Set(nestable.map((t) => t.id));
  const pinned = groups.pinned.filter((t) => !claimed.has(t.id));
  const roots = groups.threads.filter((t) => {
    const parent = parentOf(t);
    if (parent !== undefined && listed.has(parent)) return false;
    return !claimed.has(t.id);
  });
  const nestedUnder = groups.threads;
  const totals = selectProjectTotals(model, project.id);
  // the chevron overrides the default (follow the project scope) until the scope changes
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  const scoped = selectedProjectId === null || selectedProjectId === project.id;
  const expanded = override ?? scoped;
  useEffect(() => setOverride(undefined), [selectedProjectId]);
  const hasIcon = project.icon !== undefined;
  useEffect(() => {
    if (!hasIcon) detectIconOnce(project.id);
  }, [hasIcon, project.id]);

  return (
    <li className={styles.project}>
      <div
        className={styles.row}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          className={styles.chevron}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${project.title}`}
          aria-expanded={expanded}
          onClick={() => setOverride(!expanded)}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className={`${styles.projectRow} ${selectedProjectId === project.id ? styles.active : ""}`}
          title={project.rootPath}
          onClick={() => selectProject(selectedProjectId === project.id ? null : project.id)}
        >
          <ProjectIcon project={project} />
          <span className={styles.projectTitle}>{project.title}</span>
          {multiEnv ? <EnvTag envId={envOfProject(project.id)} /> : null}
          {totals.needsYou > 0 ? (
            <span className={`${styles.badge} ${styles.badgeNeeds}`} title={`${totals.needsYou} need you`}>
              ◐ {totals.needsYou}
            </span>
          ) : null}
          {totals.running > 0 ? (
            <span className={`${styles.badge} ${styles.badgeRunning}`} title={`${totals.running} running`}>
              ● {totals.running}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={styles.more}
          aria-label={`Actions for ${project.title}`}
          title="More actions"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          ⋯
        </button>
      </div>
      {menu ? (
        <ContextMenu position={menu} items={projectMenu(project)} onClose={() => setMenu(undefined)} label="Project actions" />
      ) : null}
      {expanded ? (
        <>
          {pinned.length > 0 ? (
            <div className={styles.group}>
              <span className={styles.groupHeading}>Pinned</span>
              <ul className={styles.threads} aria-label="Pinned threads">
                {pinned.map((t) => (
                  <RailThreadRow key={t.id} thread={t} siblings={nestedUnder} />
                ))}
              </ul>
            </div>
          ) : null}
          <ExpertsGroup
            projectId={project.id}
            threads={live}
            renderThread={(t) => <RailThreadRow key={t.id} thread={t} siblings={live} />}
          />
          {pinned.length > 0 && roots.length > 0 ? <span className={styles.groupHeading}>Threads</span> : null}
          <ul className={styles.threads} aria-label={pinned.length > 0 ? "Other threads" : undefined}>
            {roots.map((t) => (
              <RailThreadRow key={t.id} thread={t} siblings={nestedUnder} />
            ))}
          </ul>
          <CollapsedGroup name="Working" threads={groups.working.filter((t) => !claimed.has(t.id))} />
          <CollapsedGroup name="Snoozed" threads={groups.snoozed.filter((t) => !claimed.has(t.id))} />
          <CollapsedGroup name="Settled" threads={groups.settled} />
          <CollapsedGroup name="Archived" threads={groups.archived} clearable />
          <div className={styles.newThread}>
            <NewThreadPopover projectId={project.id} label="+ thread" variant="quiet" />
            <Button variant="quiet" onClick={() => setNewExpertsProject(project.id)}>
              + Experts
            </Button>
          </div>
          <ExpertsExplainer projectId={project.id} />
        </>
      ) : null}
    </li>
  );
}

export function ProjectTree() {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model);
  const newProjectOpen = useUi((s) => s.newProjectOpen);

  if (projects.length === 0 && !newProjectOpen) {
    return <p className={styles.empty}>No projects yet. Add one to get started.</p>;
  }
  return (
    <ul className={styles.list}>
      {projects.map((p) => (
        <ProjectNode key={p.id} project={p} />
      ))}
    </ul>
  );
}
