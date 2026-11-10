import { describe, expect, it } from "vitest";
import type { Thread } from "@tide/contracts";
import { threadSendBlock, type SendBlockKind } from "./sendBlock.ts";

const thread = (patch: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p1",
  title: "T",
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

/**
 * Twin: apps/server/src/orchestration/decider/sendBlock.test.ts runs the same fixtures through
 * the real decider (`turn.request`). The server does not depend on @tide/client, so the table is
 * kept in both files: change one, change the other.
 */
const CASES: Array<[string, Partial<Thread>, SendBlockKind | undefined]> = [
  ["a thread in its worktree", { worktreePath: "/wt/t1", branch: "tide/t1" }, undefined],
  ["a thread in the main checkout", {}, undefined],
  ["a running thread (the turn queues)", { worktreePath: "/wt/t1", branch: "tide/t1", status: "running" }, undefined],
  ["a finished rollback", { rollback: { status: "done", turnId: "u1", restoreFiles: true, at: 2 } }, undefined],
  ["merged back, worktree removed", { branch: "tide/t1", mergedAt: 5, merge: { status: "merged", strategy: "squash", at: 5 } }, "worktree-merged"],
  ["PR merged, worktree removed", { branch: "tide/t1", pr: { number: 3, url: "u", state: "merged", updatedAt: 5 } }, "worktree-merged"],
  ["worktree detached, not merged", { branch: "tide/t1" }, "worktree-removed"],
  ["archived", { archivedAt: 9, worktreePath: "/wt/t1", branch: "tide/t1" }, "archived"],
  ["rolling back", { worktreePath: "/wt/t1", branch: "tide/t1", rollback: { status: "rolling", turnId: "u1", restoreFiles: true, at: 2 } }, "rolling-back"],
];

describe("threadSendBlock", () => {
  it.each(CASES)("%s", (_name, patch, kind) => {
    expect(threadSendBlock(thread(patch))?.kind).toBe(kind);
  });

  it("says why in plain words, and offers to continue elsewhere only when the worktree is gone", () => {
    const merged = threadSendBlock(thread({ branch: "tide/t1", mergedAt: 5 }));
    expect(merged).toEqual({ kind: "worktree-merged", reason: "This thread's worktree was removed after the merge.", continueElsewhere: true });
    expect(threadSendBlock(thread({ branch: "tide/t1" }))?.reason).toBe("This thread's worktree was removed.");
    expect(threadSendBlock(thread({ archivedAt: 9 }))?.continueElsewhere).toBe(false);
  });
});
