import { afterEach, describe, expect, it } from "vitest";
import type { FsChange, FsEntry, PtyChunk, RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore, type EventStore } from "../orchestration/store.ts";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { FileService } from "../workspace/files.ts";
import { PtyManager } from "../workspace/pty.ts";
import { search } from "../workspace/search.ts";
import { FsWatcher } from "../workspace/watcher.ts";
import { RpcRouter, type RpcConnection } from "./router.ts";
import { createWorkspaceServices, registerWorkspaceHandlers, threadCwdResolver } from "./workspace.ts";

const gitFactory = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });

interface Setup {
  repo: TempRepo;
  threadId: string;
  connection: RpcConnection;
  call<T>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }>;
  stream(method: string, params: unknown): { id: string; next(match?: (c: unknown) => boolean): Promise<unknown> };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(): Promise<Setup> {
  const repo = await createTempRepo("tide-rpc-ws-");
  const store: EventStore = await openEventStore(":memory:");
  cleanups.push(() => repo.cleanup(), () => store.close());
  const engine = new Engine({ store });

  const cwdFor = threadCwdResolver(engine);
  const services = createWorkspaceServices({
    engine,
    files: new FileService({ cwdFor, git: gitFactory }),
    watcher: new FsWatcher({ debounceMs: 40, pollIntervalMs: 40, git: gitFactory }),
    ptys: new PtyManager(),
    search: (cwd, options) => search(cwd, { ...options, useRipgrep: false, git: gitFactory }),
  });
  cleanups.push(() => services.close());

  const router = new RpcRouter();
  registerWorkspaceHandlers(router, services);

  const project = (await engine.dispatch({ type: "project.create", title: "Repo", rootPath: repo.dir })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");

  const frames: RpcFrame[] = [];
  const waiters: ((f: RpcFrame) => void)[] = [];
  const connection = router.connection("c1", (frame) => {
    frames.push(frame);
    for (const waiter of waiters.splice(0)) waiter(frame);
  });
  cleanups.push(() => connection.close());

  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error(`no frame for ${method}`);
  };

  const stream = (method: string, params: unknown): Setup["stream"] extends (...a: never) => infer R ? R : never => {
    const id = `s${++seq}`;
    void connection.handleRequest(id, method, params);
    let cursor = 0;
    const next = (match?: (c: unknown) => boolean): Promise<unknown> =>
      new Promise((resolve) => {
        const scan = (): boolean => {
          while (cursor < frames.length) {
            const frame = frames[cursor++];
            if (frame === undefined || frame.id !== id || !("chunk" in frame)) continue;
            if (match === undefined || match(frame.chunk)) {
              resolve(frame.chunk);
              return true;
            }
          }
          return false;
        };
        if (scan()) return;
        const onFrame = (): void => {
          if (!scan()) waiters.push(onFrame);
        };
        waiters.push(onFrame);
      });
    return { id, next };
  };

  return { repo, threadId: thread.thread.id, connection, call, stream };
}

describe("workspace rpc: files", () => {
  it("lists, reads, writes, creates, renames and deletes", async () => {
    const { repo, threadId, call } = await setup();
    await repo.write("src/a.ts", "hello\n");

    const list = await call<{ entries: FsEntry[] }>("fs.list", { threadId });
    expect(list.result?.entries.map((e) => e.name)).toEqual(["src", "README.md"]);

    const read = await call<{ content?: string; binary: boolean; mtime: number }>("fs.read", { threadId, path: "src/a.ts" });
    expect(read.result?.content).toBe("hello\n");
    expect(read.result?.binary).toBe(false);

    const write = await call<{ mtime: number }>("fs.write", {
      threadId,
      path: "src/a.ts",
      content: "bye\n",
      ifMtime: read.result?.mtime,
    });
    expect(write.result?.mtime).toBeGreaterThan(0);

    const stale = await call("fs.write", { threadId, path: "src/a.ts", content: "x", ifMtime: 1 });
    expect(stale.error?.code).toBe("conflict");

    expect((await call("fs.create", { threadId, path: "docs", kind: "dir" })).result).toEqual({ ok: true });
    expect((await call("fs.create", { threadId, path: "docs/x.md", kind: "file" })).result).toEqual({ ok: true });
    expect((await call("fs.rename", { threadId, from: "docs/x.md", to: "docs/y.md" })).result).toEqual({ ok: true });
    expect((await call("fs.delete", { threadId, path: "docs" })).result).toEqual({ ok: true });

    expect((await call("fs.list", { threadId, path: "../.." })).error?.code).toBe("invalid-params");
    expect((await call("fs.list", { threadId: "nope" })).error?.code).toBe("not-found");
  });

  it("searches the thread's cwd", async () => {
    const { repo, threadId, call } = await setup();
    await repo.write("src/a.ts", "const needle = 1;\n");
    const result = await call<{ matches: { path: string; line: number }[]; truncated: boolean }>("fs.search", {
      threadId,
      query: "needle",
    });
    expect(result.result?.matches).toEqual([{ path: "src/a.ts", line: 1, column: 7, text: "const needle = 1;" }]);
    expect(result.result?.truncated).toBe(false);
  });
});

describe("workspace rpc: fs.watch", () => {
  it("streams changes and stops on unsubscribe", async () => {
    const { repo, threadId, stream, connection } = await setup();
    const sub = stream("fs.watch", { threadId });
    await repo.write("watched.ts", "x");
    const change = (await sub.next((c) => (c as FsChange).path === "watched.ts")) as FsChange;
    expect(change.path).toBe("watched.ts");
    expect(connection.cancelStream(sub.id)).toBe(true);
  }, 15_000);
});

describe("workspace rpc: terminals", () => {
  it("creates, attaches, writes, lists and kills", async () => {
    const { threadId, call, stream, connection } = await setup();
    const created = await call<{ ptyId: string }>("pty.create", { threadId, cols: 80, rows: 24, shell: "/bin/sh" });
    const ptyId = created.result?.ptyId;
    expect(ptyId).toBeTruthy();

    const sub = stream("pty.attach", { ptyId });
    expect((await call("pty.write", { ptyId, data: "echo tide-rpc-ok\n" })).result).toEqual({ ok: true });
    const seen: string[] = [];
    await sub.next((c) => {
      const chunk = c as PtyChunk;
      if (chunk.kind === "data") seen.push(chunk.data);
      return seen.join("").includes("tide-rpc-ok");
    });

    expect((await call("pty.resize", { ptyId, cols: 100, rows: 30 })).result).toEqual({ ok: true });
    const listed = await call<{ ptys: { ptyId: string; alive: boolean }[] }>("pty.list", { threadId });
    expect(listed.result?.ptys).toEqual([{ ptyId, title: expect.any(String), alive: true }]);

    expect((await call("pty.kill", { ptyId })).result).toEqual({ ok: true });
    await sub.next((c) => (c as PtyChunk).kind === "exit");
    connection.cancelStream(sub.id);

    expect((await call("pty.write", { ptyId: "missing" })).error?.code).toBe("invalid-params");
    expect((await call("pty.kill", { ptyId: "missing" })).error?.code).toBe("not-found");
  }, 20_000);
});
