import { useState } from "react";
import type { Project } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
import { Icon } from "../ui/Icon.tsx";
import { ContextMenu, type MenuItem, type MenuPosition } from "../ui/Menu.tsx";
import { RailSearchInput } from "./RailSearch.tsx";
import styles from "./RailHeader.module.css";

/** One action per project, or the action itself when the scope already names one. */
function perProject(
  label: string,
  projects: readonly Project[],
  scoped: Project | undefined,
  run: (projectId: string) => void,
  extra: Partial<MenuItem> = {},
): MenuItem {
  const target = scoped ?? (projects.length === 1 ? projects[0] : undefined);
  if (target !== undefined) return { label, onSelect: () => run(target.id), ...extra };
  if (projects.length === 0) return { label, disabled: true, hint: "add a project first", ...extra };
  return { label, submenu: projects.map((p) => ({ label: p.title, onSelect: () => run(p.id) })), ...extra };
}

export function newMenuItems(projects: readonly Project[], scoped: Project | undefined): MenuItem[] {
  const ui = useUi.getState();
  return [
    perProject("Thread", projects, scoped, (projectId) => ui.openNewThread({ projectId })),
    perProject("Experts session", projects, scoped, (projectId) => ui.setNewExpertsProject(projectId)),
    perProject("Team…", projects, scoped, (projectId) => ui.openNewThread({ projectId, tab: "team" })),
    { label: "Add project…", separatorBefore: true, onSelect: () => ui.setNewProjectOpen(true) },
  ];
}

/** Search field and the one `New` split button: the main half starts a thread, the chevron offers the rest. */
export function RailHeader({ projects, scoped }: { projects: readonly Project[]; scoped: Project | undefined }) {
  const [menu, setMenu] = useState<{ at: MenuPosition; items: MenuItem[] } | undefined>(undefined);
  const items = newMenuItems(projects, scoped);
  const thread = items[0];
  const openAt = (el: HTMLElement, list: MenuItem[]): void => {
    const rect = el.getBoundingClientRect();
    setMenu({ at: { x: rect.left, y: rect.bottom }, items: list });
  };
  return (
    <div className={styles.head}>
      <RailSearchInput projectId={scoped?.id ?? null} />
      <div className={styles.split}>
        <button
          type="button"
          className={styles.primary}
          title="New thread (⌘N)"
          aria-label="New"
          disabled={thread?.disabled === true}
          onClick={(e) => {
            if (thread?.onSelect) thread.onSelect();
            else if (thread?.submenu) openAt(e.currentTarget, thread.submenu);
          }}
        >
          <Icon name="plus" size={14} />
          <span>New</span>
        </button>
        <button
          type="button"
          className={styles.chevron}
          aria-label="More new…"
          aria-haspopup="menu"
          title="Thread, Experts session, team, project"
          onClick={(e) => openAt(e.currentTarget.parentElement ?? e.currentTarget, items)}
        >
          <Icon name="chevronDown" size={12} />
        </button>
      </div>
      {menu ? <ContextMenu position={menu.at} items={menu.items} onClose={() => setMenu(undefined)} label="New" /> : null}
    </div>
  );
}
