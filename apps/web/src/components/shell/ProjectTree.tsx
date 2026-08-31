import { compareByAttention, selectExpertsSessions, selectProjects, selectThreadsByProject } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { Button } from "../ui/Button.tsx";
import { NewThreadPopover } from "./NewThreadPopover.tsx";
import { ExpertsGroup, sessionThreadIds } from "./ExpertsGroup.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { PrGlyph, WorktreeGlyph } from "../ui/VcsBadges.tsx";
import styles from "./ProjectTree.module.css";

const ROLE_GLYPH: Record<NonNullable<Thread["role"]>, string> = {
  expert: "◆",
  lead: "★",
  delegate: "↳",
};

/** Delegation wins over the ordinary parent link, so a delegate nests under its caller. */
function parentOf(thread: Thread): string | undefined {
  return thread.delegatedBy ?? thread.parentThreadId;
}

function ThreadRow({ thread, siblings }: { thread: Thread; siblings: Thread[] }) {
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const view = useUi((s) => s.view);
  const selectThread = useUi((s) => s.selectThread);
  const children = siblings.filter((t) => parentOf(t) === thread.id);
  return (
    <li>
      <button
        type="button"
        className={`${styles.thread} ${
          view === "thread" && thread.id === selectedThreadId ? styles.active : ""
        }`}
        onClick={() => selectThread(thread.id)}
      >
        <StatusGlyph status={thread.status} {...(thread.attention ? { attention: thread.attention } : {})} />
        {thread.role ? (
          <span className={styles.roleGlyph} title={thread.role} aria-label={thread.role} role="img">
            {ROLE_GLYPH[thread.role]}
          </span>
        ) : null}
        <span className={styles.threadTitle}>{thread.title}</span>
        <WorktreeGlyph thread={thread} />
        <PrGlyph pr={thread.pr} />
        <span className={styles.provider}>{thread.provider}</span>
        <span className={styles.time}>{relativeTime(thread.updatedAt)}</span>
      </button>
      {children.length > 0 ? (
        <ul className={styles.threads}>
          {children.map((c) => (
            <ThreadRow key={c.id} thread={c} siblings={siblings} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ProjectNode({ projectId, title, rootPath }: { projectId: string; title: string; rootPath: string }) {
  const model = useModel((s) => s.model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  const threads = [...selectThreadsByProject(model, projectId)].sort(compareByAttention);
  const ids = new Set(threads.map((t) => t.id));
  // threads shown under a session or a delegating thread are not listed again at the top
  const claimed = new Set(selectExpertsSessions(model, projectId).flatMap(sessionThreadIds));
  const roots = threads.filter((t) => {
    const parent = parentOf(t);
    if (parent !== undefined && ids.has(parent)) return false;
    return !claimed.has(t.id);
  });
  const expanded = selectedProjectId === null || selectedProjectId === projectId;

  return (
    <li className={styles.project}>
      <button
        type="button"
        className={`${styles.projectRow} ${selectedProjectId === projectId ? styles.active : ""}`}
        onClick={() => selectProject(selectedProjectId === projectId ? null : projectId)}
      >
        <span className={styles.projectTitle}>{title}</span>
        <span className={styles.path}>{rootPath}</span>
      </button>
      {expanded ? (
        <>
          <ExpertsGroup
            projectId={projectId}
            threads={threads}
            renderThread={(t) => <ThreadRow key={t.id} thread={t} siblings={threads} />}
          />
          <ul className={styles.threads}>
            {roots.map((t) => (
              <ThreadRow key={t.id} thread={t} siblings={threads} />
            ))}
          </ul>
          <div className={styles.newThread}>
            <NewThreadPopover projectId={projectId} label="+ thread" variant="quiet" />
            <Button variant="quiet" onClick={() => setNewExpertsProject(projectId)}>
              + Experts
            </Button>
          </div>
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
        <ProjectNode key={p.id} projectId={p.id} title={p.title} rootPath={p.rootPath} />
      ))}
    </ul>
  );
}
