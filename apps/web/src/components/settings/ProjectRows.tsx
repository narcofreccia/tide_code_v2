import { useState } from "react";
import type { Project } from "@tide/contracts";
import { plural } from "../../lib/format.ts";
import { archiveProject, renameProject, setProjectPinned, unarchiveProject } from "../../lib/projectActions.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { copyText } from "../../lib/threadActions.ts";
import { envOfProject } from "../../state/environments.ts";
import { dispatchOrToast } from "../../lib/dispatchOrToast.ts";
import { useUi } from "../../state/ui.ts";
import { EnvTag } from "../fleet/FleetBits.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ContextMenu, type MenuItem, type MenuPosition } from "../ui/Menu.tsx";
import { ProjectIcon } from "../ui/ProjectIcon.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingText } from "./ui/SettingText.tsx";
import ui from "./ui/settings.module.css";
import styles from "./Projects.module.css";

/** `/Users/me/dev/tide` with the folder name kept whole and the parent ellipsised in the middle. */
export function MiddlePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/", path.length - 2);
  const head = cut > 0 ? path.slice(0, cut + 1) : "";
  const tail = cut > 0 ? path.slice(cut + 1) : path;
  return (
    <span className={styles.path} title={path}>
      <span className={styles.pathHead}>{head}</span>
      <span className={styles.pathTail}>{tail}</span>
    </span>
  );
}

function RenameField({ project, onDone }: { project: Project; onDone: () => void }) {
  const [title, setTitle] = useState(project.title);
  const commit = (): void => {
    const next = title.trim();
    onDone();
    if (next !== "" && next !== project.title) renameProject(project.id, next);
  };
  return (
    <input
      className={`${ui.input} ${styles.rename}`}
      aria-label={`Rename ${project.title}`}
      value={title}
      autoFocus
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}

/** One live project: icon, title (renamable inline), path, machine, thread count, and a `…` menu. */
export function ProjectRow({
  project,
  threads,
  multiEnv,
  onIcon,
  onRun,
}: {
  project: Project;
  threads: number;
  multiEnv: boolean;
  onIcon: () => void;
  onRun: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  const [titling, setTitling] = useState(false);
  const items: MenuItem[] = [
    { label: project.pinned ? "Unpin" : "Pin", onSelect: () => setProjectPinned(project.id, project.pinned !== true) },
    { label: "Rename", onSelect: () => setRenaming(true) },
    { label: "Icon…", onSelect: onIcon },
    { label: "Title instructions…", onSelect: () => setTitling(true) },
    { label: "Linked repositories…", onSelect: () => useUi.getState().setLinksProject(project.id) },
    { label: "Copy path", onSelect: () => void copyText(project.rootPath, "path") },
    { label: "Archive", separatorBefore: true, onSelect: () => archiveProject(project.id) },
  ];
  return (
    <SettingRow
      id={`setting-project-${project.id}`}
      label={
        <span className={styles.title}>
          <ProjectIcon project={project} />
          {renaming ? (
            <RenameField project={project} onDone={() => setRenaming(false)} />
          ) : (
            <span className={styles.name}>{project.title}</span>
          )}
          {project.pinned === true ? <Icon name="pin" size={12} /> : null}
          {multiEnv ? <EnvTag envId={envOfProject(project.id)} /> : null}
        </span>
      }
      help={<MiddlePath path={project.rootPath} />}
      extra={
        titling || project.titleInstructions !== undefined ? (
          <SettingText
            multiline
            label={`Title instructions for ${project.title}`}
            maxLength={500}
            placeholder="Uses the instructions from Settings › General"
            value={project.titleInstructions ?? ""}
            onCommit={(text) =>
              dispatchOrToast("Saving the title instructions", {
                type: "project.update",
                projectId: project.id,
                titleInstructions: text.trim() === "" ? null : text.trim(),
              })
            }
          />
        ) : undefined
      }
      control={
        <>
          <span className={styles.count}>{plural(threads, "thread")}</span>
          <Button variant="quiet" aria-label={`Run stack for ${project.title}`} onClick={onRun}>
            Run
          </Button>
          <Button
            variant="quiet"
            aria-label={`Actions for ${project.title}`}
            aria-haspopup="menu"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 180, y: rect.bottom });
            }}
          >
            <Icon name="more" />
          </Button>
          {menu ? (
            <ContextMenu position={menu} items={items} onClose={() => setMenu(undefined)} label={`${project.title} actions`} />
          ) : null}
        </>
      }
    />
  );
}

/** An archived project: when it went, how many threads it holds, and Restore. */
export function ArchivedProjectRow({ project, threads }: { project: Project; threads: number }) {
  const when = project.archivedAt === undefined ? "" : relativeTime(project.archivedAt);
  return (
    <SettingRow
      id={`setting-archived-${project.id}`}
      label={
        <span className={styles.title}>
          <ProjectIcon project={project} />
          <span className={styles.name}>{project.title}</span>
        </span>
      }
      help={
        <span className={styles.meta}>
          <MiddlePath path={project.rootPath} />
          <span>{when === "now" ? "archived just now" : `archived ${when} ago`}</span>
          <span>{plural(threads, "thread")}</span>
        </span>
      }
      control={
        <Button aria-label={`Restore ${project.title}`} onClick={() => unarchiveProject(project.id)}>
          Restore
        </Button>
      }
    />
  );
}
