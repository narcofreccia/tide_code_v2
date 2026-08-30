import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import { FileService } from "../workspace/files.ts";
import { PtyManager } from "../workspace/pty/index.ts";
import { search as runSearch, type SearchOptions, type SearchResult } from "../workspace/search.ts";
import { FsWatcher } from "../workspace/watcher.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export type SearchFn = (cwd: string, options: SearchOptions) => Promise<SearchResult>;

export interface WorkspaceServices {
  files: FileService;
  watcher: FsWatcher;
  ptys: PtyManager;
  search: SearchFn;
  /** thread -> cwd (worktree path, else project root) */
  cwdFor: (threadId: string) => string;
  close(): void;
}

export interface WorkspaceOptions {
  engine: Engine;
  files?: FileService;
  watcher?: FsWatcher;
  ptys?: PtyManager;
  search?: SearchFn;
  log?: (msg: string, data?: unknown) => void;
}

/** Resolves a thread's working directory from the read model, like the vcs handlers do. */
export function threadCwdResolver(engine: Engine): (threadId: string) => string {
  return (threadId) => {
    const model = engine.getModel();
    const thread = model.threads[threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
    const project = model.projects[thread.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
    return threadCwd(thread, project);
  };
}

/** Built once per app; `close()` kills every terminal and watcher. */
export function createWorkspaceServices(options: WorkspaceOptions): WorkspaceServices {
  const cwdFor = threadCwdResolver(options.engine);
  const files = options.files ?? new FileService({ cwdFor });
  const watcher = options.watcher ?? new FsWatcher(options.log !== undefined ? { log: options.log } : {});
  const ptys = options.ptys ?? new PtyManager(options.log !== undefined ? { log: options.log } : {});
  const search = options.search ?? runSearch;
  return {
    files,
    watcher,
    ptys,
    search,
    cwdFor,
    close() {
      ptys.closeAll();
      watcher.closeAll();
    },
  };
}

export function registerWorkspaceHandlers(router: RpcRouter, services: WorkspaceServices): void {
  const { files, watcher, ptys, search, cwdFor } = services;

  // ---- files ----
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

  // ---- terminals ----
  router.register("pty.create", async (input) => {
    const cwd = cwdFor(input.threadId);
    const ptyId = await ptys.create(input.threadId, cwd, input.cols, input.rows, input.shell);
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

  router.register("pty.list", async (input) => ({
    ptys: ptys.list(input.threadId).map((p) => ({
      ptyId: p.ptyId,
      ...(p.title !== undefined ? { title: p.title } : {}),
      alive: p.alive,
    })),
  }));
}
