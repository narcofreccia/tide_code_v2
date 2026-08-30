import { useState } from "react";
import { selectProjects, selectThreadsByProject } from "@tide/client";
import type { ProviderKind, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { createThread } from "../../lib/threadActions.ts";
import { PROVIDERS } from "../../lib/vocab.ts";
import { Button } from "../ui/Button.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import styles from "./ProjectTree.module.css";

const NEEDS_YOU_FIRST: Record<Thread["status"], number> = {
  error: 0,
  interrupted: 1,
  running: 2,
  idle: 3,
};

function ThreadRow({ thread, siblings }: { thread: Thread; siblings: Thread[] }) {
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectThread = useUi((s) => s.selectThread);
  const children = siblings.filter((t) => t.parentThreadId === thread.id);
  return (
    <li>
      <button
        type="button"
        className={`${styles.thread} ${thread.id === selectedThreadId ? styles.active : ""}`}
        onClick={() => selectThread(thread.id)}
      >
        <StatusGlyph status={thread.status} />
        <span className={styles.threadTitle}>{thread.title}</span>
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
  const [provider, setProvider] = useState<ProviderKind>("claude");

  const threads = [...selectThreadsByProject(model, projectId)].sort(
    (a, b) => NEEDS_YOU_FIRST[a.status] - NEEDS_YOU_FIRST[b.status] || b.updatedAt - a.updatedAt,
  );
  const ids = new Set(threads.map((t) => t.id));
  const roots = threads.filter((t) => t.parentThreadId === undefined || !ids.has(t.parentThreadId));
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
          <ul className={styles.threads}>
            {roots.map((t) => (
              <ThreadRow key={t.id} thread={t} siblings={threads} />
            ))}
          </ul>
          <div className={styles.newThread}>
            <select
              className={styles.providerSelect}
              aria-label={`Provider for new thread in ${title}`}
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderKind)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <Button variant="quiet" onClick={() => void createThread(projectId, provider)}>
              + thread
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
