import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effect, emit } from "../provider/testing/fakeDriver.ts";
import { checkpointRef } from "../vcs/checkpoints.ts";
import { Git, WORKTREE } from "../vcs/git.ts";
import { GIT_TEST_ENV } from "../vcs/testing/tempRepo.ts";
import { activitiesOf, harness, newThread, requestTurn, type Harness } from "../vcs/testing/vcsHarness.ts";
import { recoverRollbacks, ROLLBACK_RESTART_ERROR } from "./recovery.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A worktree thread with two turns: the first writes a.txt, the second b.txt. */
async function twoTurns(h: Harness): Promise<{ threadId: string; t1: string; t2: string; git: Git }> {
  const thread = await newThread(h, { useWorktree: true });
  h.control.script(
    emit({ type: "session", nativeSessionId: "s-1" }),
    effect(async (o) => writeFile(join(o.cwd, "a.txt"), "a\n", "utf8")),
    emit({ type: "settled", status: "completed" }),
  );
  const t1 = await requestTurn(h, thread.id, "write a");
  h.control.script(effect(async (o) => writeFile(join(o.cwd, "b.txt"), "b\n", "utf8")), emit({ type: "settled", status: "completed" }));
  const t2 = await requestTurn(h, thread.id, "write b");
  const git = new Git(h.model().threads[thread.id]?.worktreePath ?? "", { env: GIT_TEST_ENV });
  return { threadId: thread.id, t1, t2, git };
}

async function settleRollback(h: Harness): Promise<void> {
  await h.app.rollback.drain();
  await h.settle();
}

describe("RollbackService", () => {
  it("rewinds the harness, restores the files and drops the rolled-back checkpoints", async () => {
    const h = await harness(cleanups);
    h.control.setCaps({ rollback: true });
    const { threadId, t1, t2, git } = await twoTurns(h);
    await h.app.engine.dispatch({ type: "thread.rollback", threadId, turnId: t2, restoreFiles: true });
    await settleRollback(h);

    expect(h.control.rollbacks).toEqual([{ threadId, turns: 1, nativeSessionId: "s-1" }]);
    expect((await git.show(WORKTREE, "b.txt")).missing).toBe(true);
    expect((await git.show(WORKTREE, "a.txt")).missing).toBe(false);
    const model = h.model();
    expect(model.threads[threadId]).toMatchObject({ rollback: { status: "done" }, latestTurnId: t1 });
    expect(model.turns[t2]?.rolledBack).toBe(true);
    expect(await git.revParse(checkpointRef(threadId, t2, "before"))).toBeUndefined();
    expect(await git.revParse(checkpointRef(threadId, t1, "before"))).toBeDefined();
  });

  it("says so when the harness cannot forget turns, and still finishes", async () => {
    const h = await harness(cleanups);
    const { threadId, t1, t2, git } = await twoTurns(h);
    await h.app.engine.dispatch({ type: "thread.rollback", threadId, turnId: t2, restoreFiles: false });
    await settleRollback(h);

    expect(h.control.rollbacks).toEqual([]);
    expect(h.model().threads[threadId]?.rollback?.status).toBe("done");
    expect((await git.show(WORKTREE, "b.txt")).missing).toBe(false);
    const info = activitiesOf(h.model(), threadId).find((a) => a.kind === "info" && a.text.includes("cannot forget"));
    expect(info).toMatchObject({ turnId: t1, text: "harness claude cannot forget turns; the conversation was not rewound" });
  });

  it("refuses to restore files in a worktree another thread shares", async () => {
    const h = await harness(cleanups);
    h.control.setCaps({ rollback: true });
    const { threadId, t2, git } = await twoTurns(h);
    const other = await newThread(h, { title: "Neighbour" });
    const path = h.model().threads[threadId]?.worktreePath ?? "";
    await h.app.engine.dispatch({ type: "worktree.attach", threadId: other.id, worktreePath: path, branch: "x" });
    await h.app.engine.dispatch({ type: "thread.rollback", threadId, turnId: t2, restoreFiles: true });
    await settleRollback(h);

    expect(h.model().threads[threadId]?.rollback).toMatchObject({ status: "error", error: expect.stringMatching(/Neighbour.*shares this worktree/) });
    // refused before anything was touched
    expect(h.control.rollbacks).toEqual([]);
    expect((await git.show(WORKTREE, "b.txt")).missing).toBe(false);
    expect(h.model().turns[t2]?.rolledBack).toBeUndefined();
  });

  it("reports a driver failure as a failed rollback", async () => {
    const h = await harness(cleanups);
    h.control.setCaps({ rollback: true });
    h.control.rollbackError = new Error("revert refused");
    const { threadId, t2 } = await twoTurns(h);
    await h.app.engine.dispatch({ type: "thread.rollback", threadId, turnId: t2, restoreFiles: false });
    await settleRollback(h);
    expect(h.model().threads[threadId]?.rollback).toMatchObject({ status: "error", error: "revert refused" });
  });

  it("counts a harness turn as a turn the harness ran", async () => {
    const h = await harness(cleanups);
    h.control.setCaps({ rollback: true, harnessTurns: true });
    const { threadId, t2 } = await twoTurns(h);
    const session = h.control.sessionFor(threadId)!;
    // Claude Code runs a turn by itself after the second send
    const { drained } = session.emitHarnessTurn("sub-agent reported", [{ type: "assistant.delta", messageKey: "m0", delta: "report" }, { type: "settled", status: "completed" }]);
    await h.settle();
    await drained;
    const turns = Object.values(h.model().turns).filter((t) => t.threadId === threadId);
    expect(turns).toHaveLength(3);
    expect(session.dismissed).toEqual([]);
    // back to before the second send: that send and the harness turn after it
    await h.app.engine.dispatch({ type: "thread.rollback", threadId, turnId: t2, restoreFiles: false });
    await settleRollback(h);
    expect(h.control.rollbacks.map((r) => r.turns)).toEqual([2]);
  });

  it("recovery fails a rollback the previous process never finished", async () => {
    const h = await harness(cleanups);
    const { threadId, t2 } = await twoTurns(h);
    h.app.rollback.stop();
    await h.app.engine.dispatch({ type: "thread.rollback", threadId, turnId: t2, restoreFiles: false });
    expect(h.model().threads[threadId]?.rollback?.status).toBe("rolling");
    expect(await recoverRollbacks(h.app.engine)).toBe(1);
    expect(h.model().threads[threadId]?.rollback).toMatchObject({ status: "error", error: ROLLBACK_RESTART_ERROR });
  });
});
