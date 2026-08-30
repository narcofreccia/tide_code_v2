import { isAbsolute, relative, resolve } from "node:path";
import type { Project, Thread, Turn } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import type { CheckpointService } from "../vcs/checkpoints.ts";
import { Git, WORKTREE } from "../vcs/git.ts";
import { Gh, type GhLike } from "../vcs/gh.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface VcsHandlerDeps {
  engine: Engine;
  checkpoints: CheckpointService;
  gh?: GhLike;
  git?: (cwd: string) => Git;
}

interface ThreadContext {
  thread: Thread;
  project: Project;
  cwd: string;
  turns: Turn[];
}

/** Rejects any path that escapes the thread's cwd; returns the repo-relative path. */
export function safeRelativePath(cwd: string, input: string): string {
  const rel = relative(cwd, resolve(cwd, input));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RpcException("invalid-params", `path ${input} escapes the thread's working directory`);
  }
  return rel;
}

export function registerVcsHandlers(router: RpcRouter, deps: VcsHandlerDeps): void {
  const gh = deps.gh ?? new Gh();
  const git = deps.git ?? ((cwd: string) => new Git(cwd));

  const context = (threadId: string): ThreadContext => {
    const model = deps.engine.getModel();
    const thread = model.threads[threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
    const project = model.projects[thread.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
    const turns = Object.values(model.turns).filter((t) => t.threadId === thread.id);
    return { thread, project, cwd: threadCwd(thread, project), turns };
  };

  router.register("vcs.status", async (input) => {
    const ctx = context(input.threadId);
    const repo = git(ctx.cwd);
    const isRepo = await repo.isRepo();
    if (!isRepo) {
      return { cwd: ctx.cwd, isRepo: false, worktree: false, dirty: 0, hasGh: await gh.hasGh(), hasRemote: false };
    }
    const [branch, status, aheadBehind, hasRemote, hasGh] = await Promise.all([
      repo.currentBranch(),
      repo.status(),
      repo.aheadBehind(),
      repo.hasRemote(),
      gh.hasGh(),
    ]);
    return {
      cwd: ctx.cwd,
      isRepo: true,
      ...(branch !== undefined ? { branch } : {}),
      worktree: ctx.thread.worktreePath !== undefined,
      dirty: status.dirty,
      ...(aheadBehind !== undefined ? { ahead: aheadBehind.ahead, behind: aheadBehind.behind } : {}),
      hasGh,
      hasRemote,
    };
  });

  router.register("vcs.turnDiff", async (input) => {
    const ctx = context(input.threadId);
    const turn = ctx.turns.find((t) => t.id === input.turnId);
    if (!turn) throw new RpcException("not-found", `unknown turn ${input.turnId} on thread ${input.threadId}`);
    return deps.checkpoints.turnDiff(ctx.cwd, turn);
  });

  router.register("vcs.threadDiff", async (input) => {
    const ctx = context(input.threadId);
    return deps.checkpoints.threadDiff(ctx.cwd, ctx.thread, ctx.turns);
  });

  router.register("vcs.fileAt", async (input) => {
    const ctx = context(input.threadId);
    const path = safeRelativePath(ctx.cwd, input.path);
    const file = await git(ctx.cwd).show(input.ref === WORKTREE ? WORKTREE : input.ref, path);
    return {
      ...(file.content !== undefined ? { content: file.content } : {}),
      binary: file.binary,
      missing: file.missing,
    };
  });
}
