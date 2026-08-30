import type { Message, Project, ReadModel, Thread } from "@tide/contracts";

/** Non-archived projects, alphabetical by title (stable via id tiebreak). */
export function selectProjects(model: ReadModel): Project[] {
  return Object.values(model.projects)
    .filter((p) => p.archivedAt === undefined)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Non-archived threads of a project, newest first. */
export function selectThreadsByProject(model: ReadModel, projectId: string): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.projectId === projectId && t.archivedAt === undefined)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** Messages of a thread in arrival order. */
export function selectThreadMessages(model: ReadModel, threadId: string): Message[] {
  const ids = model.threadMessages[threadId] ?? [];
  const out: Message[] = [];
  for (const id of ids) {
    const m = model.messages[id];
    if (m) out.push(m);
  }
  return out;
}
