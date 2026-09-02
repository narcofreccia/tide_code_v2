import type { DiffResult, LinkedChanges, LinkedDir, Project, Thread, Turn } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveLinkedDirs } from "../provider/links.ts";
import { threadCwd } from "../provider/sessions.ts";
import type { CheckpointService } from "../vcs/checkpoints.ts";
import { Git, WORKTREE } from "../vcs/git.ts";
import { Gh, type GhLike } from "../vcs/gh.ts";
import { safeRelativePath } from "../workspace/paths.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface VcsHandlerDeps {
  engine: Engine;
  checkpoints: CheckpointService;
  gh?: GhLike;
  git?: (cwd: string) => Git;
  /** injectable clock so the PR-refresh throttle is testable without waiting a minute */
  now?: () => number;
}

/** How often one thread's pull request may be re-read from GitHub. */
const PR_REFRESH_MS = 60_000;

interface ThreadContext {
  thread: Thread;
  project: Project;
  cwd: string;
  turns: Turn[];
  links: LinkedDir[];
}

/** Re-exported for the vcs handlers and their tests; the implementation is shared. */
export { safeRelativePath };

/** The project link a resolved `LinkedDir` came from; links are keyed by path in the model. */
function linkIdFor(project: Project, path: string): string | undefined {
  return (project.links ?? []).find((link) => link.path === path)?.id;
}

export function registerVcsHandlers(router: RpcRouter, deps: VcsHandlerDeps): void {
  const gh = deps.gh ?? new Gh();
  const git = deps.git ?? ((cwd: string) => new Git(cwd));
  const now = deps.now ?? (() => Date.now());
  /** threadId -> last time its PR state was refreshed */
  const lastPrRefresh = new Map<string, number>();

  /**
   * The vcs reactor only writes `pr.update` while publishing, so a PR merged or closed on
   * GitHub afterwards would show as `open` forever. Status is the natural place to notice —
   * throttled per thread, and never allowed to fail the call.
   */
  const refreshPr = async (ctx: ThreadContext, branch: string | undefined): Promise<void> => {
    const pr = ctx.thread.pr;
    if (pr === undefined || branch === undefined) return;
    const at = now();
    const last = lastPrRefresh.get(ctx.thread.id);
    if (last !== undefined && at - last < PR_REFRESH_MS) return;
    lastPrRefresh.set(ctx.thread.id, at);
    try {
      const view = await gh.prView(ctx.cwd, branch);
      if (view === undefined || view.state === pr.state) return;
      await deps.engine.dispatch({ type: "pr.update", threadId: ctx.thread.id, pr: { ...pr, ...view, updatedAt: now() } });
    } catch {
      // gh being unavailable or unhappy must never break vcs.status
    }
  };

  const context = (threadId: string): ThreadContext => {
    const model = deps.engine.getModel();
    const thread = model.threads[threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
    const project = model.projects[thread.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
    const turns = Object.values(model.turns).filter((t) => t.threadId === thread.id);
    return { thread, project, cwd: threadCwd(thread, project), turns, links: resolveLinkedDirs(thread, project) };
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
    await refreshPr(ctx, ctx.thread.branch ?? branch);
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

  /**
   * W1: linked repos have no checkpoints (Tide only snapshots the thread's own repo), so
   * their attribution is the honest one available — the linked repo's current working-tree
   * status. Read-only links are skipped: by construction nothing there changed.
   */
  const linkedChanges = async (ctx: ThreadContext): Promise<LinkedChanges[]> => {
    const writable = ctx.links.filter((link) => link.access === "write");
    const rows = await Promise.all(
      writable.map(async (link): Promise<LinkedChanges | undefined> => {
        const repo = git(link.path);
        if (!(await repo.isRepo())) return undefined;
        const files = await repo.statusFiles();
        if (files.length === 0) return undefined; // an untouched link is not worth a row
        const id = linkIdFor(ctx.project, link.path);
        if (id === undefined) return undefined;
        return { linkId: id, label: link.label, path: link.path, files };
      }),
    );
    return rows.filter((row): row is LinkedChanges => row !== undefined);
  };

  const withLinked = async (ctx: ThreadContext, diff: DiffResult): Promise<DiffResult> => {
    const linked = await linkedChanges(ctx);
    return linked.length === 0 ? diff : { ...diff, linked };
  };

  router.register("vcs.turnDiff", async (input) => {
    const ctx = context(input.threadId);
    const turn = ctx.turns.find((t) => t.id === input.turnId);
    if (!turn) throw new RpcException("not-found", `unknown turn ${input.turnId} on thread ${input.threadId}`);
    return withLinked(ctx, await deps.checkpoints.turnDiff(ctx.cwd, turn));
  });

  router.register("vcs.threadDiff", async (input) => {
    const ctx = context(input.threadId);
    return withLinked(ctx, await deps.checkpoints.threadDiff(ctx.cwd, ctx.thread, ctx.turns));
  });

  /**
   * Discards working-tree changes inside one linked repo. Every path is re-checked against
   * the link root (`safeRelativePath`), so nothing outside it can ever be touched, and
   * untracked files are removed only when the caller named them.
   */
  router.register("vcs.linkedRevert", async (input) => {
    const ctx = context(input.threadId);
    const link = ctx.links.find((l) => linkIdFor(ctx.project, l.path) === input.linkId);
    if (!link) throw new RpcException("not-found", `unknown link ${input.linkId} on thread ${input.threadId}`);
    if (link.access !== "write") throw new RpcException("conflict", `link ${link.label} is read-only`);
    const repo = git(link.path);
    if (!(await repo.isRepo())) throw new RpcException("conflict", `${link.path} is not a git repository`);

    const status = await repo.statusFiles();
    const wanted = input.files?.map((file) => safeRelativePath(link.path, file));
    const selected = wanted === undefined ? status : status.filter((entry) => wanted.includes(entry.path));
    const untracked = selected.filter((entry) => entry.status === "??").map((entry) => entry.path);
    const tracked = selected.filter((entry) => entry.status !== "??").map((entry) => entry.path);
    await repo.restore(tracked);
    // only ever the untracked files the caller listed; a bare revert leaves them in place
    if (wanted !== undefined) await repo.removeUntracked(untracked);
    return { reverted: wanted === undefined ? tracked : [...tracked, ...untracked] };
  });

  /**
   * W1: an absolute path inside a linked repo is served from that repo. Checkpoint refs only
   * exist in the thread's own repo, so for linked files any non-worktree ref means "HEAD" —
   * the honest before/after available there (see linkedChanges).
   */
  const linkedTarget = (ctx: ThreadContext, input: string): { root: string; rel: string } | undefined => {
    if (!isAbsolute(input)) return undefined;
    for (const link of ctx.links) {
      const rel = relative(link.path, resolve(input));
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return { root: link.path, rel };
    }
    return undefined;
  };

  router.register("vcs.fileAt", async (input) => {
    const ctx = context(input.threadId);
    const linked = linkedTarget(ctx, input.path);
    const root = linked?.root ?? ctx.cwd;
    const path = linked?.rel ?? safeRelativePath(ctx.cwd, input.path);
    const ref = input.ref === WORKTREE ? WORKTREE : linked ? "HEAD" : input.ref;
    const file = await git(root).show(ref, path);
    return {
      ...(file.content !== undefined ? { content: file.content } : {}),
      binary: file.binary,
      missing: file.missing,
    };
  });
}
