import type { DiffFile, RpcOutput } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import type { CheckpointService } from "../vcs/checkpoints.ts";
import { callerThread, reachable } from "./agentThreads.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface AgentDiffDeps {
  engine: Engine;
  checkpoints: CheckpointService;
}

export const DEFAULT_DIFF_CHARS_PER_FILE = 8000;

type AgentDiffFile = RpcOutput<"agent.thread.diff">["files"][number];

/** One file as an agent sees it: the patch cut at `max` characters, binary files without one. */
export function boundFile(file: DiffFile, max: number): AgentDiffFile {
  const base = { path: file.path, status: file.status, additions: file.additions, deletions: file.deletions };
  if (file.binary === true || file.patch === undefined) return { ...base, truncated: false };
  const truncated = file.patch.length > max;
  return { ...base, patch: truncated ? file.patch.slice(0, max) : file.patch, truncated };
}

/**
 * R5 `agent.thread.diff`: what a thread changed (its first before-checkpoint → the working tree),
 * the same diff `vcs.threadDiff` shows the user, bounded per file. Reachable threads only, like
 * `agent.thread.read` — a reviewer reads the implementer's work through it.
 */
export function registerAgentDiffHandler(router: RpcRouter, deps: AgentDiffDeps): void {
  router.register("agent.thread.diff", async (input, ctx) => {
    const model = deps.engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    const project = model.projects[target.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${target.projectId}`);
    const turns = Object.values(model.turns).filter((t) => t.threadId === target.id);
    const diff = await deps.checkpoints.threadDiff(threadCwd(target, project), target, turns);
    const max = input.maxCharsPerFile ?? DEFAULT_DIFF_CHARS_PER_FILE;
    return { base: diff.base, head: diff.head, files: diff.files.map((file) => boundFile(file, max)) };
  });
}
