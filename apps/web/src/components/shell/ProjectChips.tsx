import { useState } from "react";
import { selectProjectTotals, selectRailGroups } from "@tide/client";
import type { Project } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { pinnedFirst } from "../../lib/projectActions.ts";
import { envOfProject } from "../../state/environments.ts";
import { Icon } from "../ui/Icon.tsx";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import { ProjectIcon } from "../ui/ProjectIcon.tsx";
import { EnvTag } from "../fleet/FleetBits.tsx";
import { useMultiEnv } from "../fleet/envView.ts";
import { projectMenu } from "./railMenus.ts";
import { useProjectScope } from "./useProjectScope.ts";
import styles from "./ProjectChips.module.css";

/** Past this many chips the row scrolls and fades at its edge. */
const FADE_AFTER = 5;

function ProjectChip({ project, active }: { project: Project; active: boolean }) {
  const selectProject = useUi((s) => s.selectProject);
  const toggleProjectFilter = useUi((s) => s.toggleProjectFilter);
  // live = what the Inbox and Needs you groups hold: pinned and loose, not working / snoozed / settled
  const live = useModel((s) => {
    const g = selectRailGroups(s.model, project.id);
    return g.pinned.length + g.threads.length;
  });
  const running = useModel((s) => selectProjectTotals(s.model, project.id).running);
  const needsYou = useModel((s) => selectProjectTotals(s.model, project.id).needsYou);
  const multiEnv = useMultiEnv();
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  return (
    <li
      className={`${styles.chip} ${active ? styles.active : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        className={styles.main}
        title={project.rootPath}
        aria-pressed={active}
        onClick={(e) => (e.metaKey || e.ctrlKey ? toggleProjectFilter(project.id) : selectProject(project.id))}
      >
        <span className={styles.icon}>
          <ProjectIcon project={project} />
        </span>
        <span className={styles.name}>{project.title}</span>
        {project.pinned === true ? (
          <span className={styles.pin} data-chip-pinned="">
            <Icon name="pin" size={10} />
          </span>
        ) : null}
        <span className={styles.count}>· {live}</span>
        {running > 0 ? <span className={`${styles.dot} ${styles.running}`} role="img" aria-label="running" title={`${running} running`} /> : null}
        {needsYou > 0 ? <span className={`${styles.dot} ${styles.needs}`} role="img" aria-label="needs you" title={`${needsYou} need you`} /> : null}
        {multiEnv ? <EnvTag envId={envOfProject(project.id)} /> : null}
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
        <Icon name="more" size={12} />
      </button>
      {menu ? <ContextMenu position={menu} items={projectMenu(project)} onClose={() => setMenu(undefined)} label="Project actions" /> : null}
    </li>
  );
}

/**
 * The rail's scope: `All` then one chip per project (pinned first; click filters to it, ⌘-click adds or removes). Projects are a filter over the
 * groups below, not a tree. With a single project there is nothing to filter, so
 * the row is not drawn.
 */
export function ProjectChips({ projects }: { projects: readonly Project[] }) {
  const clearProjectFilter = useUi((s) => s.clearProjectFilter);
  const scope = useProjectScope(projects.map((p) => p.id));
  if (projects.length <= 1) return null;
  const all = scope.length === 0;
  return (
    <ul className={`${styles.row} ${projects.length + 1 > FADE_AFTER ? styles.fade : ""}`} aria-label="Projects">
      <li className={`${styles.chip} ${all ? styles.active : ""}`}>
        <button type="button" className={styles.main} aria-pressed={all} onClick={clearProjectFilter}>
          <span className={styles.name}>All</span>
        </button>
      </li>
      {pinnedFirst(projects).map((p) => (
        <ProjectChip key={p.id} project={p} active={scope.includes(p.id)} />
      ))}
    </ul>
  );
}
