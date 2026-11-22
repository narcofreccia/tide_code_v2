import { memo, useMemo, useState } from "react";
import { selectChildAttention, selectRepoGroups } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { envOfProject } from "../../state/environments.ts";
import { EnvTag } from "../fleet/FleetBits.tsx";
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

/** `key` is the repo group's key (`remoteUrl` or `path:<projectId>`). */
export const folderKey = (groupKey: string): string => `project:${groupKey}`;

/** Rows for a folder's threads: roots first, children nested under their parent via `siblings`. */
function Rows({ threads, now, label, showProject = false }: { threads: Thread[]; now: number; label: string; showProject?: boolean }) {
  const allThreads = useModel((s) => s.model.threads);
  const { roots, siblings } = useMemo(() => {
    const ids = new Set(threads.map((t) => t.id));
    const rootList = threads.filter((t) => {
      const parent = parentOf(t);
      return parent === undefined || !ids.has(parent);
    });
    const extras: Thread[] = [];
    const seen = new Set(ids);
    const queue = [...ids];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const candidate of Object.values(allThreads)) {
        if (candidate.archivedAt !== undefined || candidate.delegatedBy !== pid || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        extras.push(candidate);
        queue.push(candidate.id);
      }
    }
    return { roots: rootList, siblings: extras.length > 0 ? [...threads, ...extras] : threads };
  }, [threads, allThreads]);
  return (
    <ul className={styles.list} aria-label={label}>
      {roots.map((t) => (
        <RailThreadRow key={t.id} thread={t} siblings={siblings} showProject={showProject} now={now} />
      ))}
    </ul>
  );
}

const Folder = memo(function Folder({ folder, collapsed, onToggle, now }: { folder: RailFolder; collapsed: boolean; onToggle: () => void; now: number }) {
  const { project, threads } = folder;
  const title = folder.label;
  const envIds = [...new Set(folder.projects.map((p) => envOfProject(p.id)))];
  const childAttention = useModel((s) => collapsed && threads.some((t) => selectChildAttention(s.model, t.id, now)));
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  const needsDot = collapsed && (folder.needsCount > 0 || childAttention);
  return (
    <section className={styles.folder} aria-label={title} data-rail-group={folderKey(folder.key)}>
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
          <span className={styles.title}>{title}</span>
          {envIds.length >= 2 ? envIds.map((envId) => <EnvTag key={envId ?? "none"} envId={envId} />) : null}
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
          aria-label={`Actions for ${title}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <Icon name="more" size={12} />
        </button>
        {menu ? <ContextMenu position={menu} items={projectFolderMenu(project)} onClose={() => setMenu(undefined)} label="Project actions" /> : null}
      </div>
      {collapsed ? null : <Rows threads={threads} now={now} label={`${title} threads`} />}
    </section>
  );
});

/**
 * The rail grouped by project: pinned threads, then one folder per project, then the
 * status tail (Snoozed · Settled · Archived). Rows carry the same `data-rail-thread`
 * markup as the status view, so j/k/e/s/m walk across folders (a folded one has no rows).
 */
export function RailProjectFolders({ projectIds, filter }: { projectIds: readonly string[]; filter: readonly string[] }) {
  const now = useTicker(60_000);
  const workingSection = useServerSettings((s) => s.settings.inbox.workingSection);
  const { folds, toggle } = useGroupFolds();
  const { groups } = useRailGroups(projectIds, now, workingSection);
  const allGroups = useModel((s) => selectRepoGroups(s.model));
  const repoGroups = useMemo(() => allGroups.filter((g) => g.projects.some((p) => projectIds.includes(p.id))), [allGroups, projectIds]);
  const model = useMemo(
    () => buildRailProjectModel(groups.map((g) => g.group), repoGroups, filter),
    [groups, repoGroups, filter],
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
          key={folder.key}
          folder={folder}
          collapsed={isGroupCollapsed(folds, folderKey(folder.key))}
          onToggle={() => toggle(folderKey(folder.key))}
          now={now}
        />
      ))}
      <RailGroups projectIds={projectIds} showProject={projectIds.length > 1} only={["snoozed", "settled", "archived"]} />
    </div>
  );
}
