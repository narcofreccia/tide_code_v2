import { afterEach, describe, expect, it } from "vitest";
import type { DiffResult, RpcFrame, VcsStatus } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore, type EventStore } from "../orchestration/store.ts";
import { CheckpointService } from "../vcs/checkpoints.ts";
import { Git, WORKTREE } from "../vcs/git.ts";
import type { GhLike, PrRef } from "../vcs/gh.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { RpcRouter } from "./router.ts";
import { registerVcsHandlers, safeRelativePath } from "./vcs.ts";

const noGh: GhLike = {
  async hasGh() {
    return false;
  },
  async prCreate() {
    throw new Error("not used");
  },
  async prView(): Promise<PrRef | undefined> {
    return undefined;
  },
};

interface Setup {
  repo: TempRepo;
  call<T>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }>;
  engine: Engine;
  threadId: string;
  turnId: string;
  checkpoints: CheckpointService;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface SetupOptions {
  gh?: GhLike;
  now?: () => number;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const repo = await createTempRepo("tide-rpc-vcs-");
  const store: EventStore = await openEventStore(":memory:");
  cleanups.push(() => repo.cleanup(), async () => store.close());
  const engine = new Engine({ store });
  const git = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });
  const checkpoints = new CheckpointService({ git });

  const router = new RpcRouter();
  registerVcsHandlers(router, {
    engine,
    checkpoints,
    gh: options.gh ?? noGh,
    git,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const project = (await engine.dispatch({ type: "project.create", title: "Repo", rootPath: repo.dir })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");
  const turn = (await engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "go" })).events[0]?.event;
  if (turn?.type !== "turn.requested") throw new Error("expected turn.requested");

  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error(`no frame for ${method}`);
  };
  return { repo, call, engine, threadId: thread.thread.id, turnId: turn.turn.id, checkpoints };
}

describe("safeRelativePath", () => {
  it("rejects escapes and accepts nested paths", () => {
    expect(safeRelativePath("/repo", "src/a.ts")).toBe("src/a.ts");
    expect(() => safeRelativePath("/repo", "../secrets")).toThrow(/escapes/);
    expect(() => safeRelativePath("/repo", "/etc/passwd")).toThrow(/escapes/);
    expect(() => safeRelativePath("/repo", ".")).toThrow(/escapes/);
  });
});

describe("rpc vcs.status", () => {
  it("reports the thread's repository state", async () => {
    const s = await setup();
    await s.repo.write("dirty.txt", "x\n");
    const { result } = await s.call<VcsStatus>("vcs.status", { threadId: s.threadId });
    expect(result).toMatchObject({ cwd: s.repo.dir, isRepo: true, branch: "main", worktree: false, dirty: 1, hasGh: false, hasRemote: false });
    expect(result?.ahead).toBeUndefined();
  });

  it("rejects an unknown thread", async () => {
    const s = await setup();
    const { error } = await s.call("vcs.status", { threadId: "nope" });
    expect(error?.code).toBe("not-found");
  });

  it("refreshes a stale pull request state, at most once a minute", async () => {
    /** `gh` that reports the PR as merged and counts how often it was asked. */
    class FakeGh implements GhLike {
      views = 0;
      async hasGh(): Promise<boolean> {
        return true;
      }
      async prCreate(): Promise<{ url: string; number: number }> {
        throw new Error("not used");
      }
      async prView(): Promise<PrRef | undefined> {
        this.views++;
        return { url: "https://github.com/o/r/pull/7", number: 7, state: "merged" };
      }
    }
    const gh = new FakeGh();
    let now = 1_000_000;
    const s = await setup({ gh, now: () => now });
    await s.engine.dispatch({
      type: "pr.update",
      threadId: s.threadId,
      pr: { url: "https://github.com/o/r/pull/7", number: 7, state: "open", updatedAt: now },
    });

    await s.call<VcsStatus>("vcs.status", { threadId: s.threadId });
    expect(gh.views).toBe(1);
    expect(s.engine.getModel().threads[s.threadId]?.pr).toMatchObject({ number: 7, state: "merged" });

    // a second call moments later must not hit the network again
    await s.call<VcsStatus>("vcs.status", { threadId: s.threadId });
    expect(gh.views).toBe(1);

    now += 60_001;
    await s.call<VcsStatus>("vcs.status", { threadId: s.threadId });
    expect(gh.views).toBe(2);
  });

  it("does not ask gh about a thread that has no pull request", async () => {
    let views = 0;
    const gh: GhLike = {
      ...noGh,
      async prView() {
        views++;
        return undefined;
      },
    };
    const s = await setup({ gh });
    await s.call<VcsStatus>("vcs.status", { threadId: s.threadId });
    expect(views).toBe(0);
  });
});

describe("rpc vcs.turnDiff / vcs.threadDiff", () => {
  it("returns the diff a turn produced", async () => {
    const s = await setup();
    const before = await s.checkpoints.recordBefore(s.repo.dir, s.threadId, s.turnId);
    await s.engine.dispatch({ type: "checkpoint.record", turnId: s.turnId, phase: "before", ref: before.ref });
    await s.repo.write("agent.txt", "hello\n");
    const after = await s.checkpoints.recordAfter(s.repo.dir, s.threadId, s.turnId);
    await s.engine.dispatch({ type: "checkpoint.record", turnId: s.turnId, phase: "after", ref: after.ref, ...(after.stats ? { stats: after.stats } : {}) });

    const { result } = await s.call<DiffResult>("vcs.turnDiff", { threadId: s.threadId, turnId: s.turnId });
    expect(result?.files.map((f) => f.path)).toEqual(["agent.txt"]);
    expect(result?.files[0]).toMatchObject({ status: "added", additions: 1 });
  });

  it("rejects a turn that is not on the thread", async () => {
    const s = await setup();
    const { error } = await s.call("vcs.turnDiff", { threadId: s.threadId, turnId: "nope" });
    expect(error?.code).toBe("not-found");
  });

  it("threadDiff spans the whole thread down to the working tree", async () => {
    const s = await setup();
    const before = await s.checkpoints.recordBefore(s.repo.dir, s.threadId, s.turnId);
    await s.engine.dispatch({ type: "checkpoint.record", turnId: s.turnId, phase: "before", ref: before.ref });
    await s.repo.write("one.txt", "1\n");
    await s.repo.write("two.txt", "2\n");

    const { result } = await s.call<DiffResult>("vcs.threadDiff", { threadId: s.threadId });
    expect(result?.head).toBe(WORKTREE);
    expect(result?.files.map((f) => f.path)).toEqual(["one.txt", "two.txt"]);
  });
});

describe("rpc vcs.fileAt", () => {
  it("reads a file at a ref and from the working tree", async () => {
    const s = await setup();
    const head = (await s.repo.git.revParse("HEAD")) ?? "";
    await s.repo.write("README.md", "# changed\n");

    expect((await s.call<{ content?: string }>("vcs.fileAt", { threadId: s.threadId, ref: head, path: "README.md" })).result).toEqual({
      content: "# temp\n",
      binary: false,
      missing: false,
    });
    expect((await s.call<{ content?: string }>("vcs.fileAt", { threadId: s.threadId, ref: WORKTREE, path: "README.md" })).result).toEqual({
      content: "# changed\n",
      binary: false,
      missing: false,
    });
    expect((await s.call("vcs.fileAt", { threadId: s.threadId, ref: WORKTREE, path: "missing.txt" })).result).toEqual({
      binary: false,
      missing: true,
    });
  });

  it("rejects paths that escape the thread's cwd", async () => {
    const s = await setup();
    for (const path of ["../outside.txt", "/etc/passwd", "src/../../escape.txt"]) {
      const { error } = await s.call("vcs.fileAt", { threadId: s.threadId, ref: WORKTREE, path });
      expect(error).toMatchObject({ code: "invalid-params" });
    }
  });
});
