import { memo, useMemo, useState } from "react";
import { selectChildAttention } from "@tide/client";
import type { Project, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useTicker } from "../mission/useTicker.ts";
import { Icon } from "../ui/Icon.tsx";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import { ProjectIcon } from "../ui/ProjectIcon.tsx";
import { StateGlyph } from "../ui/StatusGlyph.tsx";
import { RailGroups } from "./RailGroups.tsx";
import { RailThreadRow } from "./RailThreadRow.tsx";
import { isGroupCollapsed, useGroupFolds } from "./railGroupState.ts";
import { projectFolderMenu } from "./railMenus.ts";
import { buildRailProjectModel, type RailFolder } from "./railProjectModel.ts";
import { parentOf } from "./railTree.ts";
import { useRailGroups } from "./useRailGroups.ts";
import styles from "./RailProjectFolders.module.css";

export const folderKey = (projectId: string): string => `project:${projectId}`;

/** Rows for a folder's threads: roots first, children nested under their parent via `siblings`. */
function Rows({ threads, now, label, showProject = false }: { threads: Thread[]; now: number; label: string; showProject?: boolean }) {
  const roots = useMemo(() => {
    const ids = new Set(threads.map((t) => t.id));
    return threads.filter((t) => {
      const parent = parentOf(t);
      return parent === undefined || !ids.has(parent);
    });
  }, [threads]);
  return (
    <ul className={styles.list} aria-label={label}>
      {roots.map((t) => (
        <RailThreadRow key={t.id} thread={t} siblings={threads} showProject={showProject} now={now} />
      ))}
    </ul>
  );
}

const Folder = memo(function Folder({ folder, collapsed, onToggle, now }: { folder: RailFolder; collapsed: boolean; onToggle: () => void; now: number }) {
  const { project, threads } = folder;
  const childAttention = useModel((s) => collapsed && threads.some((t) => selectChildAttention(s.model, t.id, now)));
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  const needsDot = collapsed && (folder.needsCount > 0 || childAttention);
  return (
    <section className={styles.folder} aria-label={project.title} data-rail-group={folderKey(project.id)}>
      <div
        className={styles.head}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button type="button" className={styles.toggle} aria-expanded={!collapsed} onClick={onToggle}>
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
          <span className={styles.icon}>
            <ProjectIcon project={project} />
          </span>
          <span className={styles.title}>{project.title}</span>
          {project.pinned === true ? (
            <span className={styles.pin} data-folder-pinned="">
              <Icon name="pin" size={10} />
            </span>
          ) : null}
          {needsDot ? <span className={styles.dot} role="img" aria-label="needs you" data-folder-needs="" /> : null}
          {collapsed && folder.running ? (
            <span className={styles.running} data-group-running="">
              <StateGlyph state="running" />
            </span>
          ) : null}
          <span className={styles.count}>{threads.length}</span>
        </button>
        <button
          type="button"
          className={styles.more}
          aria-label={`Actions for ${project.title}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <Icon name="more" size={12} />
        </button>
        {menu ? <ContextMenu position={menu} items={projectFolderMenu(project)} onClose={() => setMenu(undefined)} label="Project actions" /> : null}
      </div>
      {collapsed ? null : <Rows threads={threads} now={now} label={`${project.title} threads`} />}
    </section>
  );
});

/**
 * The rail grouped by project: pinned threads, then one folder per project, then the
 * status tail (Snoozed · Settled · Archived). Rows carry the same `data-rail-thread`
 * markup as the status view, so j/k/e/s/m walk across folders (a folded one has no rows).
 */
export function RailProjectFolders({ projects, projectIds, filter }: { projects: readonly Project[]; projectIds: readonly string[]; filter: readonly string[] }) {
  const now = useTicker(60_000);
  const workingSection = useServerSettings((s) => s.settings.inbox.workingSection);
  const { folds, toggle } = useGroupFolds();
  const { groups } = useRailGroups(projectIds, now, workingSection);
  const model = useMemo(
    () => buildRailProjectModel(groups.map((g) => g.group), projects.filter((p) => projectIds.includes(p.id)), filter),
    [groups, projects, projectIds, filter],
  );
  return (
    <div>
      {model.pinnedThreads.length > 0 ? (
        <section className={styles.pinned} aria-label="Pinned" data-rail-group="pinned">
          <Rows threads={model.pinnedThreads} now={now} label="Pinned threads" showProject />
        </section>
      ) : null}
      {model.folders.map((folder) => (
        <Folder
          key={folder.project.id}
          folder={folder}
          collapsed={isGroupCollapsed(folds, folderKey(folder.project.id))}
          onToggle={() => toggle(folderKey(folder.project.id))}
          now={now}
        />
      ))}
      <RailGroups projectIds={projectIds} showProject={projectIds.length > 1} only={["snoozed", "settled", "archived"]} />
    </div>
  );
}
