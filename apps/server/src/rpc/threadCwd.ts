import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import { RpcException } from "./router.ts";

/**
 * Resolves a thread's working directory from the read model, like the vcs handlers do. A thread
 * whose worktree was detached is refused: falling back to the project root would let the editor
 * and terminal write into the user's main checkout (the decider refuses `turn.request` alike).
 */
export function threadCwdResolver(engine: Engine): (threadId: string) => string {
  return (threadId) => {
    const model = engine.getModel();
    const thread = model.threads[threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
    if (thread.worktreePath === undefined && thread.branch !== undefined) {
      throw new RpcException("conflict", `thread ${threadId} has no worktree any more`);
    }
    const project = model.projects[thread.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
    return threadCwd(thread, project);
  };
}
