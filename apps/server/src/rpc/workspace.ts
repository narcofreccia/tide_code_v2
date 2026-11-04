import { realpath } from "node:fs/promises";
import type { Project } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import { sharingThread } from "../vcs/restore.ts";
import { browseDirectories, type BrowseResult } from "../workspace/browse.ts";
import { FileService } from "../workspace/files.ts";
import { PtyManager } from "../workspace/pty/index.ts";
import { search as runSearch, type SearchOptions, type SearchResult } from "../workspace/search.ts";
import { FsWatcher } from "../workspace/watcher.ts";
import { PortLister, within } from "../workspace/ports.ts";
import { registerAttachmentHandlers } from "./attachments.ts";
import { createOpenExternal, type OpenExternalFn } from "./workspaceOpen.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export type SearchFn = (cwd: string, options: SearchOptions) => Promise<SearchResult>;

export interface WorkspaceServices {
  engine: Engine;
  files: FileService;
  watcher: FsWatcher;
  ptys: PtyManager;
  search: SearchFn;
  /** listening ports under the thread's terminals (cached 3 s) */
  ports: PortLister;
  /** hands an editor deep link / web URL to the OS opener */
  openExternal: OpenExternalFn;
  /** thread -> cwd (worktree path, else project root) */
  cwdFor: (threadId: string) => string;
  /** directory browser for the project picker */
  browse: (input: { path?: string; showHidden?: boolean }) => Promise<BrowseResult>;
  /** kills the thread's terminals and stops the watch on its worktree (which is going away) */
  teardown(threadId: string, worktreePath?: string): void;
  close(): void;
}

export interface WorkspaceOptions {
  engine: Engine;
  files?: FileService;
  watcher?: FsWatcher;
  ptys?: PtyManager;
  search?: SearchFn;
  ports?: PortLister;
  openExternal?: OpenExternalFn;
  log?: (msg: string, data?: unknown) => void;
}

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

/**
 * A run-stack terminal's cwd must exist and sit inside the project root or one of its linked repos
 * (realpaths on both sides, so a symlink cannot point it elsewhere).
 */
export async function runCwdInside(project: Project, cwd: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(cwd);
  } catch {
    throw new RpcException("not-found", `working directory ${cwd} does not exist`);
  }
  for (const root of [project.rootPath, ...(project.links ?? []).map((l) => l.path)]) {
    const rootReal = await realpath(root).catch(() => undefined);
    if (rootReal !== undefined && within(real, rootReal)) return real;
  }
  throw new RpcException("forbidden", `${cwd} is outside the project and its linked repos`);
}

/** Built once per app; `close()` kills every terminal and watcher. */
export function createWorkspaceServices(options: WorkspaceOptions): WorkspaceServices {
  const cwdFor = threadCwdResolver(options.engine);
  const files = options.files ?? new FileService({ cwdFor });
  const watcher = options.watcher ?? new FsWatcher(options.log !== undefined ? { log: options.log } : {});
  const ptys = options.ptys ?? new PtyManager(options.log !== undefined ? { log: options.log } : {});
  const search = options.search ?? runSearch;
  const teardown = (threadId: string, worktreePath?: string): void => {
    ptys.killThread(threadId);
    if (worktreePath !== undefined) watcher.closeCwd(worktreePath);
  };
  // the vcs reactor calls teardown right before it removes a worktree; these cover the rest
  const unsubscribe = options.engine.subscribe((record) => {
    const event = record.event;
    if (event.type === "thread.archived") {
      const model = options.engine.getModel();
      const thread = model.threads[event.threadId];
      // a checkout another live thread still runs in keeps its watcher
      teardown(event.threadId, thread !== undefined && sharingThread(model, thread) === undefined ? thread.worktreePath : undefined);
    }
    else if (event.type === "thread.deleted") {
      // the thread is gone from the model; any live thread left on the same path keeps the watcher
      const shared = event.worktreePath !== undefined &&
        Object.values(options.engine.getModel().threads).some((t) => t.archivedAt === undefined && t.worktreePath === event.worktreePath);
      teardown(event.threadId, shared ? undefined : event.worktreePath);
    }
    else if (event.type === "worktree.detached") ptys.killThread(event.threadId);
  });
  return {
    engine: options.engine,
    files,
    watcher,
    ptys,
    search,
    ports: options.ports ?? new PortLister(),
    openExternal: options.openExternal ?? createOpenExternal(),
    cwdFor,
    browse: (input) => browseDirectories(options.engine.getModel(), input),
    teardown,
    close() {
      unsubscribe();
      ptys.closeAll();
      watcher.closeAll();
    },
  };
}

export function registerWorkspaceHandlers(router: RpcRouter, services: WorkspaceServices): void {
  const { files, watcher, ptys, search, cwdFor } = services;

  // ---- files ----
  registerAttachmentHandlers(router, { engine: services.engine, cwdFor });

  router.register("fs.list", async (input) => ({
    entries: await files.list(input.threadId, input.path),
  }));

  router.register("fs.read", async (input) => {
    const file = await files.read(input.threadId, input.path);
    return {
      ...(file.content !== undefined ? { content: file.content } : {}),
      binary: file.binary,
      size: file.size,
      mtime: file.mtime,
    };
  });

  router.register("fs.readBinary", async (input) =>
    files.readBinary(input.threadId, input.path, input.maxBytes),
  );

  router.register("fs.write", async (input) =>
    files.write(input.threadId, input.path, input.content, input.ifMtime),
  );

  router.register("fs.create", async (input) => {
    await files.create(input.threadId, input.path, input.kind);
    return { ok: true };
  });

  router.register("fs.rename", async (input) => {
    await files.rename(input.threadId, input.from, input.to);
    return { ok: true };
  });

  router.register("fs.delete", async (input) => {
    await files.delete(input.threadId, input.path);
    return { ok: true };
  });

  router.registerStream("fs.watch", async (input, _ctx, emit) => {
    const cwd = cwdFor(input.threadId);
    return watcher.subscribe(cwd, emit);
  });

  router.register("fs.browse", async (input) =>
    services.browse({
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.showHidden !== undefined ? { showHidden: input.showHidden } : {}),
    }),
  );

  router.register("fs.search", async (input) => {
    const cwd = cwdFor(input.threadId);
    return search(cwd, {
      query: input.query,
      ...(input.regex !== undefined ? { regex: input.regex } : {}),
      ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive } : {}),
      ...(input.glob !== undefined ? { glob: input.glob } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  });

  // ---- ports (Preview tab) ----
  // the thread's terminal shells and their children, plus any listener running inside its worktree
  // (an agent's own Bash tool starts dev servers outside Tide's terminals)
  router.register("ports.list", async (input) => {
    const cwd = cwdFor(input.threadId); // not-found for unknown threads
    return { ports: await services.ports.list(ptys.pids(input.threadId), { cwd }) };
  });

  // editor deep links from the desktop WebView, which refuses custom-scheme navigations
  router.register("workspace.openExternal", async (input) => services.openExternal(input.url));

  // ---- terminals ----
  // a thread's terminal runs in the thread's cwd; a run-stack terminal (`run:<projectId>`) names its
  // own cwd, which must be inside the project or a linked repo
  router.register("pty.create", async (input) => {
    let ownerId: string;
    let cwd: string;
    if (input.threadId !== undefined) {
      ownerId = input.threadId;
      cwd = cwdFor(input.threadId);
    } else if (input.ownerId !== undefined && input.ownerId.startsWith("run:")) {
      ownerId = input.ownerId;
      const project = services.engine.getModel().projects[ownerId.slice(4)];
      if (project === undefined) throw new RpcException("not-found", `unknown project ${ownerId.slice(4)}`);
      if (input.cwd === undefined) throw new RpcException("invalid-params", "a run terminal needs a cwd");
      cwd = await runCwdInside(project, input.cwd);
    } else {
      throw new RpcException("invalid-params", "pty.create needs a threadId or a run:<projectId> ownerId");
    }
    const ptyId = await ptys.create({
      ownerId,
      cwd,
      cols: input.cols,
      rows: input.rows,
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
    });
    return { ptyId };
  });

  router.registerStream("pty.attach", async (input, _ctx, emit) => ptys.attach(input.ptyId, emit));

  router.register("pty.write", async (input) => {
    ptys.write(input.ptyId, input.data);
    return { ok: true };
  });

  router.register("pty.resize", async (input) => {
    ptys.resize(input.ptyId, input.cols, input.rows);
    return { ok: true };
  });

  router.register("pty.kill", async (input) => {
    ptys.kill(input.ptyId);
    return { ok: true };
  });

  router.register("pty.list", async (input) => {
    const owner = input.ownerId ?? input.threadId;
    if (owner === undefined) throw new RpcException("invalid-params", "pty.list needs a threadId or an ownerId");
    return {
      ptys: ptys.list(owner).map((p) => ({
        ptyId: p.ptyId,
        ...(p.title !== undefined ? { title: p.title } : {}),
        alive: p.alive,
        ...(p.label !== undefined ? { label: p.label } : {}),
      })),
    };
  });
}
