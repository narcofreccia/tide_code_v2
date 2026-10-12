import { afterEach, describe, expect, it } from "vitest";
import type { FsChange } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { PtyManager } from "../workspace/pty/index.ts";
import type { PtyBackend, PtyHandle } from "../workspace/pty/types.ts";
import { FsWatcher } from "../workspace/watcher.ts";
import { RpcException } from "./router.ts";
import { createWorkspaceServices, threadCwdResolver } from "./workspace.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Terminals that only count kills; no process is spawned. */
function countingBackend(): { backend: PtyBackend; killed: () => number } {
  let killed = 0;
  const backend: PtyBackend = {
    name: "node-pty",
    spawn(): PtyHandle {
      let onExit: (e: { code?: number }) => void = () => undefined;
      return {
        onData: () => undefined,
        onExit: (cb) => {
          onExit = cb;
        },
        write: () => undefined,
        resize: () => undefined,
        kill: () => {
          killed++;
          onExit({ code: 143 });
        },
      };
    },
  };
  return { backend, killed: () => killed };
}

async function setup(): Promise<{ engine: Engine; threadId: string; worktreePath: string; ptys: PtyManager; watcher: FsWatcher; killed: () => number; services: ReturnType<typeof createWorkspaceServices> }> {
  const store = await openEventStore(":memory:");
  const engine = new Engine({ store });
  const { backend, killed } = countingBackend();
  const ptys = new PtyManager({ backend });
  const watcher = new FsWatcher({ strategy: "poll", pollIntervalMs: 60_000 });
  const services = createWorkspaceServices({ engine, ptys, watcher });
  cleanups.push(() => services.close(), () => store.close());

  const project = (await engine.dispatch({ type: "project.create", title: "Repo", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");
  const worktreePath = "/tmp/tide-teardown-wt";
  await engine.dispatch({ type: "worktree.attach", threadId: thread.thread.id, worktreePath, branch: "tide/x", baseBranch: "main" });
  return { engine, threadId: thread.thread.id, worktreePath, ptys, watcher, killed, services };
}

describe("workspace teardown", () => {
  it("refuses fs/pty work on a thread whose worktree was detached (no fallback to the main checkout)", async () => {
    const { engine, threadId } = await setup();
    const cwdFor = threadCwdResolver(engine);
    expect(cwdFor(threadId)).toBe("/tmp/tide-teardown-wt");
    await engine.dispatch({ type: "worktree.detached", threadId });
    let code: string | undefined;
    try {
      cwdFor(threadId);
    } catch (err) {
      code = err instanceof RpcException ? err.code : undefined;
    }
    expect(code).toBe("conflict");
  });

  it("kills the thread's terminals when its worktree is detached", async () => {
    const { engine, threadId, ptys, killed } = await setup();
    await ptys.create(threadId, "/tmp", 80, 24, "/bin/sh");
    await ptys.create("other-thread", "/tmp", 80, 24, "/bin/sh");
    await engine.dispatch({ type: "worktree.detached", threadId });
    expect(killed()).toBe(1);
    expect(ptys.list(threadId).every((p) => !p.alive)).toBe(true);
    expect(ptys.list("other-thread").every((p) => p.alive)).toBe(true);
  });

  it("kills terminals and stops the worktree watch when the thread is archived", async () => {
    const { engine, threadId, worktreePath, ptys, watcher, killed } = await setup();
    await ptys.create(threadId, "/tmp", 80, 24, "/bin/sh");
    const seen: FsChange[] = [];
    watcher.subscribe(worktreePath, (c) => seen.push(c));
    expect(watcher.size).toBe(1);
    await engine.dispatch({ type: "thread.archive", threadId, keepWorktree: true });
    expect(killed()).toBe(1);
    expect(watcher.size).toBe(0);
  });

  it("teardown() is what the vcs reactor calls right before removing a worktree", async () => {
    const { threadId, worktreePath, ptys, watcher, killed, services } = await setup();
    await ptys.create(threadId, "/tmp", 80, 24, "/bin/sh");
    const release = watcher.subscribe(worktreePath, () => undefined);
    services.teardown(threadId, worktreePath);
    expect(killed()).toBe(1);
    expect(watcher.size).toBe(0);
    // a late unsubscribe from the stream must not disturb a newer watch on the same path
    const again = watcher.subscribe(worktreePath, () => undefined);
    release();
    expect(watcher.size).toBe(1);
    again();
    expect(watcher.size).toBe(0);
  });
});
