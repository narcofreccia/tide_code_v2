import type { DiffFile, DiffResult, LinkedChanges } from "@tide/contracts";

/** One linked repository's working-tree changes for a turn. */
export type LinkedDiffGroup = LinkedChanges;
export type LinkedDiffFile = LinkedChanges["files"][number];

const STATUSES: DiffFile["status"][] = ["added", "modified", "deleted", "renamed"];

/** Linked files carry a free-form status on the wire; anything unknown reads as modified. */
export function diffStatus(status: string): DiffFile["status"] {
  return STATUSES.find((s) => s === status) ?? "modified";
}

/**
 * The diff's linked groups, or `[]`. `linked` is optional (a thread with no
 * write links, or a server that predates W1), so it is read defensively.
 */
export function linkedGroups(diff: DiffResult | undefined): LinkedDiffGroup[] {
  const groups = diff?.linked;
  if (!Array.isArray(groups)) return [];
  return groups.filter((g) => Array.isArray(g.files) && g.files.length > 0);
}

export function joinPath(root: string, relative: string): string {
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

/** Row key for a linked file; a space cannot occur in the link id. */
export function linkedKey(group: LinkedDiffGroup, path: string): string {
  return `${group.linkId} ${path}`;
}

/**
 * A linked file as a `DiffFile`, at its absolute path so the diff pane reads it
 * from the linked repository rather than the thread's worktree. Line counts are
 * not reported per linked file, so they stay at zero.
 */
export function toDiffFile(group: LinkedDiffGroup, file: LinkedDiffFile): DiffFile {
  return { path: joinPath(group.path, file.path), status: diffStatus(file.status), additions: 0, deletions: 0 };
}

/** The linked file a row key names, if any. */
export function findLinkedFile(
  groups: readonly LinkedDiffGroup[],
  key: string,
): { group: LinkedDiffGroup; file: LinkedDiffFile } | undefined {
  for (const group of groups) {
    for (const file of group.files) {
      if (linkedKey(group, file.path) === key) return { group, file };
    }
  }
  return undefined;
}
