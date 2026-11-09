import { repoDisplayName, type Project, type ReadModel } from "@tide/contracts";

/** One repository as the user sees it: every non-archived project that is a clone of it, across machines. */
export interface RepoGroup {
  key: string;
  label: string;
  projects: Project[];
  /** pinned first, then the oldest: the sibling that stands for the group where one is needed */
  lead: Project;
}

const byLead = (a: Project, b: Project): number =>
  Number(b.pinned === true) - Number(a.pinned === true) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

const cache = new WeakMap<ReadModel["projects"], RepoGroup[]>();

/**
 * Projects grouped by `repo.remoteUrl` (a project without a detected repo is its own group, keyed
 * `path:<id>`). Archived projects are left out. Groups with a pinned member come first, then by
 * label. Memoised on the `projects` map, which the projector replaces only when a project changes.
 */
export function selectRepoGroups(model: ReadModel): RepoGroup[] {
  const hit = cache.get(model.projects);
  if (hit !== undefined) return hit;
  const buckets = new Map<string, Project[]>();
  for (const p of Object.values(model.projects)) {
    if (p.archivedAt !== undefined) continue;
    const key = p.repo?.remoteUrl ?? `path:${p.id}`;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [p]);
    else list.push(p);
  }
  const groups: RepoGroup[] = [];
  for (const [key, list] of buckets) {
    const projects = [...list].sort(byLead);
    const lead = projects[0];
    if (lead === undefined) continue;
    const remote = lead.repo?.remoteUrl;
    groups.push({ key, label: remote === undefined ? lead.title : repoDisplayName(remote), projects, lead });
  }
  groups.sort(
    (a, b) =>
      Number(b.lead.pinned === true) - Number(a.lead.pinned === true) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
  cache.set(model.projects, groups);
  return groups;
}

/** The group a project belongs to (undefined for an unknown or archived project). */
export function repoGroupOf(model: ReadModel, projectId: string): RepoGroup | undefined {
  return selectRepoGroups(model).find((g) => g.projects.some((p) => p.id === projectId));
}

/** The other clones of the same repo (not the project itself), oldest-first / pinned-first. */
export function selectRepoSiblings(model: ReadModel, projectId: string): Project[] {
  return repoGroupOf(model, projectId)?.projects.filter((p) => p.id !== projectId) ?? [];
}
