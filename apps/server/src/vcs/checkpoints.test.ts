import { afterEach, describe, expect, it } from "vitest";
import type { Thread, Turn } from "@tide/contracts";
import { CheckpointService, checkpointRef } from "./checkpoints.ts";
import { Git, WORKTREE } from "./git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "./testing/tempRepo.ts";

const repos: TempRepo[] = [];
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo("tide-cp-");
  repos.push(r);
  return r;
}
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

const service = (): CheckpointService => new CheckpointService({ git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }) });

const turn = (id: string, checkpoint?: Turn["checkpoint"], requestedAt = 1): Turn => ({
  id,
  threadId: "T1",
  status: "completed",
  requestedAt,
  ...(checkpoint !== undefined ? { checkpoint } : {}),
});

const thread = (patch: Partial<Thread> = {}): Thread => ({
  id: "T1",
  projectId: "P1",
  title: "Thread",
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("CheckpointService — recording", () => {
  it("records before and after under refs/tide/checkpoints and computes stats", async () => {
    const r = await repo();
    const cp = service();
    await r.write("app.ts", "one\n");
    await r.commit("base");

    const before = await cp.recordBefore(r.dir, "T1", "U1");
    expect(before.ref).toBe(checkpointRef("T1", "U1", "before"));
    expect(await r.git.revParse(before.ref)).toBe(before.sha);

    await r.write("app.ts", "one\ntwo\n");
    await r.write("new-file.ts", "fresh\n");
    const after = await cp.recordAfter(r.dir, "T1", "U1");
    expect(after.ref).toBe(checkpointRef("T1", "U1", "after"));
    expect(after.stats).toEqual({ files: 2, additions: 2, deletions: 0 });
  });

  it("after-stats are undefined when the before-ref is gone", async () => {
    const r = await repo();
    const after = await service().recordAfter(r.dir, "T1", "UX");
    expect(after.stats).toBeUndefined();
  });

  it("the before-gate opens once the snapshot is recorded, and on failure", async () => {
    const r = await repo();
    const cp = service();
    let opened = false;
    cp.expect("U1");
    const gate = cp.beforeReady("U1").then(() => {
      opened = true;
    });
    expect(opened).toBe(false);
    await cp.recordBefore(r.dir, "T1", "U1");
    await gate;
    expect(opened).toBe(true);
    // an unexpected turn never blocks
    await cp.beforeReady("never-registered");
  });
});

describe("CheckpointService — diffs", () => {
  it("turnDiff shows before → after, and falls back to the working tree while running", async () => {
    const r = await repo();
    const cp = service();
    await r.write("a.txt", "one\n");
    await r.commit("base");

    const before = await cp.recordBefore(r.dir, "T1", "U1");
    await r.write("a.txt", "one\ntwo\n");

    const live = await cp.turnDiff(r.dir, turn("U1", { before: before.ref }));
    expect(live.head).toBe(WORKTREE);
    expect(live.files.map((f) => f.path)).toEqual(["a.txt"]);

    const after = await cp.recordAfter(r.dir, "T1", "U1");
    const settled = await cp.turnDiff(r.dir, turn("U1", { before: before.ref, after: after.ref }));
    expect(settled.head).toBe(after.ref);
    expect(settled.files[0]).toMatchObject({ path: "a.txt", additions: 1, deletions: 0 });
  });

  it("turnDiff of an uncheckpointed turn is empty", async () => {
    const r = await repo();
    expect((await service().turnDiff(r.dir, turn("U9"))).files).toEqual([]);
  });

  it("threadDiff spans from the first turn's before-checkpoint to the working tree", async () => {
    const r = await repo();
    const cp = service();
    await r.write("a.txt", "start\n");
    await r.commit("base");

    const first = await cp.recordBefore(r.dir, "T1", "U1");
    await r.write("a.txt", "turn one\n");
    await cp.recordAfter(r.dir, "T1", "U1");
    const second = await cp.recordBefore(r.dir, "T1", "U2");
    await r.write("b.txt", "turn two\n");

    const diff = await cp.threadDiff(r.dir, thread(), [turn("U2", { before: second.ref }, 2), turn("U1", { before: first.ref }, 1)]);
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("threadDiff falls back to baseBranch when no checkpoint exists", async () => {
    const r = await repo();
    await r.write("a.txt", "start\n");
    await r.commit("base");
    await r.git.run(["checkout", "-q", "-b", "feature"]);
    await r.write("a.txt", "changed on branch\n");
    await r.commit("branch work");
    await r.write("dirty.txt", "uncommitted\n");

    const diff = await service().threadDiff(r.dir, thread({ baseBranch: "main" }), []);
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt", "dirty.txt"]);
  });

  it("threadDiff falls back to HEAD when there is no base branch either", async () => {
    const r = await repo();
    await r.write("only-worktree.txt", "x\n");
    const diff = await service().threadDiff(r.dir, thread(), []);
    expect(diff.files.map((f) => f.path)).toEqual(["only-worktree.txt"]);
  });
});

describe("CheckpointService — revert", () => {
  it("restores the working tree and deletes files created after the checkpoint", async () => {
    const r = await repo();
    const cp = service();
    await r.write("a.txt", "original\n");
    await r.commit("base");
    const before = await cp.recordBefore(r.dir, "T1", "U1");

    await r.write("a.txt", "agent rewrote this\n");
    await r.write("agent-made-this.txt", "delete me\n");

    await cp.revertTo(r.dir, before.ref);
    expect((await r.git.show(WORKTREE, "a.txt")).content).toBe("original\n");
    expect((await r.git.show(WORKTREE, "agent-made-this.txt")).missing).toBe(true);
  });

  it("throws for a checkpoint that no longer exists", async () => {
    const r = await repo();
    await expect(service().revertTo(r.dir, "refs/tide/checkpoints/T1/GONE/before")).rejects.toThrow(/no longer exists/);
  });
});
