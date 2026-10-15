import { realpath as fsRealpath } from "node:fs/promises";
import type { Project, ReadModel, Thread } from "@tide/contracts";
import type { CheckpointService } from "./checkpoints.ts";

/**
 * Puts the working tree back to the state before `turnId` (its before-checkpoint). Shared by
 * `thread.revert` and `thread.rollback { restoreFiles }`. Returns the turn's 1-based position in
 * the thread; throws when the turn has no checkpoint or the ref is gone.
 */
export async function restoreBeforeTurn(checkpoints: CheckpointService, model: ReadModel, threadId: string, turnId: string, cwd: string): Promise<number> {
  const before = model.turns[turnId]?.checkpoint?.before;
  if (before === undefined) throw new Error("this turn has no checkpoint");
  await checkpoints.revertTo(cwd, before);
  const ordered = Object.values(model.turns)
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => a.requestedAt - b.requestedAt);
  return ordered.findIndex((t) => t.id === turnId) + 1;
}

async function real(path: string, resolve: (p: string) => Promise<string>): Promise<string> {
  try {
    return await resolve(path);
  } catch {
    return path;
  }
}

/**
 * Why restoring files for `thread` would touch someone else's work, or undefined when it is safe:
 * the thread runs in the project's main checkout, or another live thread shares its worktree.
 */
export async function sharedCheckoutReason(
  model: ReadModel,
  thread: Thread,
  project: Project,
  resolve: (p: string) => Promise<string> = fsRealpath,
): Promise<string | undefined> {
  if (thread.worktreePath === undefined) return "the thread runs in the project's main checkout; restoring files requires a worktree";
  const mine = await real(thread.worktreePath, resolve);
  if (mine === (await real(project.rootPath, resolve))) return "the thread runs in the project's main checkout; restoring files requires a worktree";
  for (const other of Object.values(model.threads)) {
    if (other.id === thread.id || other.archivedAt !== undefined || other.worktreePath === undefined) continue;
    if ((await real(other.worktreePath, resolve)) === mine) return `thread "${other.title}" shares this worktree; restoring files would change its work too`;
  }
  return undefined;
}
