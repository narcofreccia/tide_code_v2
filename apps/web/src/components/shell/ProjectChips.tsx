import { useState } from "react";
import { selectProjectTotals, selectRailGroups, selectRepoGroups, type RepoGroup } from "@tide/client";
import type { Project, ReadModel } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { envOfProject } from "../../state/environments.ts";
import { Icon } from "../ui/Icon.tsx";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import { ProjectIcon } from "../ui/ProjectIcon.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { EnvTag } from "../fleet/FleetBits.tsx";
import { useMultiEnv } from "../fleet/envView.ts";
import { selectProjectScope } from "./projectSelection.ts";
import { projectMenu } from "./railMenus.ts";
import { useProjectScope } from "./useProjectScope.ts";
import styles from "./ProjectChips.module.css";

const ALL_VALUE = "__all";
const MULTI_VALUE = "__multi";

function groupCounts(model: ReadModel, projects: readonly Project[]): { live: number; running: number; needsYou: number } {
  let live = 0;
  let running = 0;
  let needsYou = 0;
  for (const p of projects) {
    const g = selectRailGroups(model, p.id);
    live += g.pinned.length + g.threads.length;
    const totals = selectProjectTotals(model, p.id);
    running += totals.running;
    needsYou += totals.needsYou;
  }
  return { live, running, needsYou };
}

function ProjectChip({ group, active }: { group: RepoGroup; active: boolean }) {
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
  // the project's own short name; the repo (owner/name) and every clone's path are in the tooltip
  const name = lead.title || group.label;
  const tooltip = [group.label !== name ? group.label : undefined, ...projects.map((p) => p.rootPath)].filter(Boolean).join("\n");
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
        title={tooltip}
        aria-pressed={active}
        onClick={(e) => (e.metaKey || e.ctrlKey ? toggleGroup() : selectProjectScope(ids))}
      >
        <span className={styles.icon}>
          <ProjectIcon project={project} />
        </span>
        <span className={styles.name}>{name}</span>
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
        aria-label={`Actions for ${name}`}
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

function ProjectSelect({ groups, scope }: { groups: readonly RepoGroup[]; scope: readonly string[] }) {
  const clearProjectFilter = useUi((s) => s.clearProjectFilter);
  const model = useModel((s) => s.model);
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);

  const activeGroups = groups.filter((g) => g.projects.some((p) => scope.includes(p.id)));
  const singleGroup = activeGroups.length === 1 ? activeGroups[0] : undefined;
  const value = scope.length === 0 ? ALL_VALUE : singleGroup !== undefined ? singleGroup.key : MULTI_VALUE;

  const totalLive = groups.reduce((n, g) => n + groupCounts(model, g.projects).live, 0);
  const options: SelectOption<string>[] = [
    ...(value === MULTI_VALUE ? [{ value: MULTI_VALUE, label: `${activeGroups.length} projects`, disabled: true }] : []),
    {
      value: ALL_VALUE,
      label: "All projects",
      description: totalLive === 0 ? "No active threads" : `${totalLive} active`,
    },
    ...groups.map((g): SelectOption<string> => {
      const name = g.lead.title || g.label;
      const { live, running, needsYou } = groupCounts(model, g.projects);
      const parts = [
        `${live} active`,
        running > 0 ? `${running} running` : undefined,
        needsYou > 0 ? `${needsYou} needs you` : undefined,
      ].filter(Boolean);
      return {
        value: g.key,
        label: `${name} · ${live}`,
        description: parts.join(" · "),
        icon: (
          <span className={styles.icon}>
            <ProjectIcon project={g.lead} />
          </span>
        ),
      };
    }),
  ];

  const singleName = singleGroup ? (singleGroup.lead.title || singleGroup.label) : undefined;
  return (
    <div className={styles.selectRow}>
      <Select
        label="Projects"
        value={value}
        options={options}
        variant="field"
        size="sm"
        className={styles.selectControl}
        onSelect={(next) => {
          if (next === ALL_VALUE) {
            clearProjectFilter();
            return;
          }
          const picked = groups.find((g) => g.key === next);
          if (picked) selectProjectScope(picked.projects.map((p) => p.id));
        }}
      />
      {singleGroup !== undefined && singleName !== undefined ? (
        <>
          <button
            type="button"
            className={styles.selectMore}
            aria-label={`Actions for ${singleName}`}
            title="More actions"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <Icon name="more" size={12} />
          </button>
          {menu ? <ContextMenu position={menu} items={projectMenu(singleGroup.lead)} onClose={() => setMenu(undefined)} label="Project actions" /> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The rail's scope: `All` then one chip per repository (pinned first; click filters to it and every clone of it on other machines, ⌘-click adds or removes the whole
 * repo), named by the project's title, or a compact dropdown Select when configured in Settings › Appearance.
 * With a single repository there is nothing to filter, so the row is not drawn.
 */
export function ProjectChips({ projects }: { projects: readonly Project[] }) {
  const clearProjectFilter = useUi((s) => s.clearProjectFilter);
  const selectorStyle = useSettings((s) => s.projectSelector);
  const groups = useModel((s) => selectRepoGroups(s.model));
  const scope = useProjectScope(projects.map((p) => p.id));
  if (groups.length <= 1) return null;
  if (selectorStyle === "select") return <ProjectSelect groups={groups} scope={scope} />;
  const all = scope.length === 0;
  return (
    <ul className={styles.row} aria-label="Projects">
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
