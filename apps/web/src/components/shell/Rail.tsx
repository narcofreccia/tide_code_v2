import { useEffect, useLayoutEffect, useRef } from "react";
import { selectProjects } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { clampRailWidth, useUi } from "../../state/ui.ts";
import { useSettings } from "../../state/settings.ts";
import { useRailSearch } from "../../state/railSearch.ts";
import { detectIconOnce } from "../../lib/projectIcon.ts";
import { ProjectChips } from "./ProjectChips.tsx";
import { RailEmpty } from "./RailEmpty.tsx";
import { RailGroups } from "./RailGroups.tsx";
import { RailHeader } from "./RailHeader.tsx";
import { RailProjectFolders } from "./RailProjectFolders.tsx";
import { RailSearchResults } from "./RailSearch.tsx";
import { RailSelectionBar } from "./RailSelectionBar.tsx";
import { Strip } from "./Strip.tsx";
import { useInboxKeys } from "./useInboxKeys.ts";
import { useMarkSeen } from "./useMarkSeen.ts";
import { useProjectScope } from "./useProjectScope.ts";
import styles from "./Rail.module.css";

/** Projects without an icon get one detected once (favicon / emoji), wherever they are listed. */
function useDetectIcons(ids: string): void {
  useEffect(() => {
    for (const id of ids.split("\n")) if (id !== "") detectIconOnce(id);
  }, [ids]);
}

/** Drag handle on the panel's right edge: 240–360px, persisted. */
function ResizeHandle() {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  return (
    <div
      className={styles.resize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize rail"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, width: useUi.getState().railWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current === undefined) return;
        useUi.getState().setRailWidth(start.current.width + e.clientX - start.current.x);
      }}
      onPointerUp={() => {
        start.current = undefined;
      }}
      onDoubleClick={() => useUi.getState().setRailWidth(clampRailWidth(280))}
    />
  );
}

/** The rail panel: header (search, New), project chips, then the groups or the search results. */
function RailPanel() {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model);
  const groupBy = useSettings((s) => s.railGroupBy);
  const width = useUi((s) => s.railWidth);
  const navRef = useRef<HTMLElement>(null);
  // a custom property, not a style object: the CSS owns the layout
  useLayoutEffect(() => {
    navRef.current?.style.setProperty("--rail-w", `${width}px`);
  }, [width]);
  const query = useRailSearch((s) => s.query);
  const filter = useProjectScope(projects.map((p) => p.id));
  const scoped = filter.length === 1 ? projects.find((p) => p.id === filter[0]) : undefined;
  const projectIds = filter.length > 0 ? filter : projects.map((p) => p.id);
  const showProject = scoped === undefined && projects.length > 1;
  const anyThread = Object.values(model.threads).some((t) => projectIds.includes(t.projectId));
  useDetectIcons(projects.filter((p) => p.icon === undefined).map((p) => p.id).join("\n"));

  let body: React.ReactNode;
  if (projects.length === 0) body = <RailEmpty kind="projects" />;
  else if (query.trim() !== "")
    body = <RailSearchResults query={query} projectId={scoped?.id ?? null} projectIds={projectIds} showProject={showProject} />;
  else if (!anyThread) body = <RailEmpty kind="threads" projectId={scoped?.id ?? projects[0]?.id ?? ""} />;
  else if (groupBy === "project") body = <RailProjectFolders projects={projects} projectIds={projectIds} filter={filter} />;
  else body = <RailGroups projectIds={projectIds} showProject={showProject} />;

  return (
    <nav ref={navRef} className={styles.panel} aria-label="Navigation">
      <RailHeader projects={projects} scoped={scoped} />
      <ProjectChips projects={projects} />
      <RailSelectionBar />
      <div className={styles.scroll}>{body}</div>
      <ResizeHandle />
    </nav>
  );
}

/**
 * Desktop sidebar: the 44px icon strip, always, and beside it the rail panel
 * unless collapsed (⌘B, or the strip's Inbox button).
 */
export function Rail() {
  const collapsed = useUi((s) => s.railCollapsed);
  useInboxKeys();
  useMarkSeen();
  return (
    <div className={styles.sidebar}>
      <Strip />
      {collapsed ? null : <RailPanel />}
    </div>
  );
}
