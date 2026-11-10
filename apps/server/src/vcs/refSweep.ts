import { existsSync, realpathSync } from "node:fs";
import type { Project, ReadModel } from "@tide/contracts";
import type { Git } from "./git.ts";

/** Every per-turn checkpoint ref lives under this prefix: `<prefix><threadId>/<turnId>/{before,after}`. */
export const CHECKPOINT_PREFIX = "refs/tide/checkpoints/";

export interface RefSweepDeps {
  git: (cwd: string) => Git;
  log: (msg: string, data?: unknown) => void;
}

export interface RefSweepOptions {
  /**
   * True when this server's own log created the thread. A ref is only deleted for a thread the
   * log knew and the model no longer has (deleted while the server died), never for an id the
   * log never saw: another TIDE_HOME on the same repo, or threads newer than a restored backup.
   * Undefined: every thread id missing from the model counts as deleted.
   */
  knownToLog?: (threadId: string) => boolean;
  /** stdin batch size for `update-ref --stdin` */
  batch?: number;
}

export interface RefSweepResult {
  /** repo root → refs deleted there */
  deleted: Map<string, number>;
}

function canon(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * R19 L2: drops checkpoint refs whose thread is gone. `thread.deleted` removes them live; a crash
 * between the event and that cleanup leaves them forever. One `git for-each-ref` per distinct
 * repository and batched `update-ref --stdin` deletions; archived threads are still in the model
 * and keep theirs. Never throws: each repository's failure is logged and the sweep goes on.
 */
export async function sweepOrphanCheckpointRefs(deps: RefSweepDeps, model: ReadModel, options: RefSweepOptions = {}): Promise<RefSweepResult> {
  const result: RefSweepResult = { deleted: new Map() };
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const project of Object.values(model.projects) as Project[]) {
    if (!existsSync(project.rootPath)) continue;
    const key = canon(project.rootPath);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(project.rootPath);
  }
  const batch = Math.max(1, options.batch ?? 500);
  for (const root of roots) {
    try {
      const git = deps.git(root);
      const listed = await git.tryRun(["for-each-ref", "--format=%(refname)", CHECKPOINT_PREFIX]);
      if (listed.code !== 0) continue; // not a repository (any more)
      const orphans: string[] = [];
      for (const ref of listed.stdout.split("\n")) {
        const name = ref.trim();
        if (!name.startsWith(CHECKPOINT_PREFIX)) continue;
        const threadId = name.slice(CHECKPOINT_PREFIX.length).split("/")[0] ?? "";
        if (threadId === "" || model.threads[threadId] !== undefined) continue;
        if (options.knownToLog !== undefined && !options.knownToLog(threadId)) continue;
        orphans.push(name);
      }
      let removed = 0;
      for (let i = 0; i < orphans.length; i += batch) {
        const chunk = orphans.slice(i, i + batch);
        const r = await git.tryRunWithInput(["update-ref", "--stdin"], chunk.map((ref) => `delete ${ref}\n`).join(""));
        if (r.code !== 0) {
          deps.log(`[vcs-recovery] could not delete orphan checkpoint refs in ${root}`, r.stderr.trim());
          break;
        }
        removed += chunk.length;
      }
      if (removed > 0) result.deleted.set(root, removed);
    } catch (err) {
      deps.log(`[vcs-recovery] checkpoint ref sweep skipped ${root}`, err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}
