import { useState } from "react";
import { selectProjectTotals, selectRailGroups, selectRepoGroups, type RepoGroup } from "@tide/client";
import type { Project } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
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

function ProjectChip({ group, active }: { group: RepoGroup; active: boolean }) {
  const selectProjects = useUi((s) => s.selectProjects);
  const { lead, projects } = group;
  const ids = projects.map((p) => p.id);
  // live = what the Inbox and Needs you groups hold: pinned and loose, not working / snoozed / settled
  const live = useModel((s) =>
    projects.reduce((n, p) => {
      const g = selectRailGroups(s.model, p.id);
      return n + g.pinned.length + g.threads.length;
    }, 0),
  );
  const running = useModel((s) => projects.reduce((n, p) => n + selectProjectTotals(s.model, p.id).running, 0));
  const needsYou = useModel((s) => projects.reduce((n, p) => n + selectProjectTotals(s.model, p.id).needsYou, 0));
  const multiEnv = useMultiEnv();
  const envIds = [...new Set(projects.map((p) => envOfProject(p.id)))];
  const spansMachines = envIds.length >= 2;
  const toggleGroup = (): void => {
    const ui = useUi.getState();
    const all = ids.every((id) => ui.projectFilter.includes(id));
    const filter = all ? ui.projectFilter.filter((id) => !ids.includes(id)) : [...ui.projectFilter, ...ids.filter((id) => !ui.projectFilter.includes(id))];
    useUi.setState({ projectFilter: filter, selectedProjectId: filter.length === 1 ? (filter[0] ?? null) : null });
  };
  const project = lead;
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
        title={projects.map((p) => p.rootPath).join("\n")}
        aria-pressed={active}
        onClick={(e) => (e.metaKey || e.ctrlKey ? toggleGroup() : selectProjects(ids))}
      >
        <span className={styles.icon}>
          <ProjectIcon project={project} />
        </span>
        <span className={styles.name}>{group.label}</span>
        {project.pinned === true ? (
          <span className={styles.pin} data-chip-pinned="">
            <Icon name="pin" size={10} />
          </span>
        ) : null}
        <span className={styles.count}>· {live}</span>
        {running > 0 ? <span className={`${styles.dot} ${styles.running}`} role="img" aria-label="running" title={`${running} running`} /> : null}
        {needsYou > 0 ? <span className={`${styles.dot} ${styles.needs}`} role="img" aria-label="needs you" title={`${needsYou} need you`} /> : null}
        {spansMachines
          ? envIds.map((envId) => <EnvTag key={envId ?? "none"} envId={envId} />)
          : multiEnv
            ? <EnvTag envId={envIds[0]} />
            : null}
      </button>
      <button
        type="button"
        className={styles.more}
        aria-label={`Actions for ${group.label}`}
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
 * The rail's scope: `All` then one chip per repository (pinned first; click filters to it and every clone of it on other machines, ⌘-click adds or removes the whole
 * repo). Chips are a filter over the groups below, not a tree. With a single repository there is nothing to filter, so
 * the row is not drawn.
 */
export function ProjectChips({ projects }: { projects: readonly Project[] }) {
  const clearProjectFilter = useUi((s) => s.clearProjectFilter);
  const groups = useModel((s) => selectRepoGroups(s.model));
  const scope = useProjectScope(projects.map((p) => p.id));
  if (groups.length <= 1) return null;
  const all = scope.length === 0;
  return (
    <ul className={`${styles.row} ${groups.length + 1 > FADE_AFTER ? styles.fade : ""}`} aria-label="Projects">
      <li className={`${styles.chip} ${all ? styles.active : ""}`}>
        <button type="button" className={styles.main} aria-pressed={all} onClick={clearProjectFilter}>
          <span className={styles.name}>All</span>
        </button>
      </li>
      {groups.map((g) => (
        <ProjectChip key={g.key} group={g} active={g.projects.some((p) => scope.includes(p.id))} />
      ))}
    </ul>
  );
}
