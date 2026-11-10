import { describe, expect, it } from "vitest";
import { emptyReadModel, type Project, type ReadModel, type Thread } from "@tide/contracts";
import { decide } from "./index.ts";

const ctx = { now: 1000, newId: (() => { let n = 0; return () => `id${++n}`; })() };

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

const project: Project = { id: "p1", title: "P", rootPath: "/repo", createdAt: 1, updatedAt: 1 };

function modelWith(t: Thread): ReadModel {
  const empty = emptyReadModel();
  return { ...empty, projects: { p1: project }, threads: { [t.id]: t } };
}

type Kind = "archived" | "rolling-back" | "worktree-merged" | "worktree-removed";

/**
 * Twin: packages/client/src/sendBlock.test.ts runs the same fixtures through `threadSendBlock`,
 * the composer's mirror of these refusals. The server does not depend on @tide/client, so the
 * table is kept in both files: change one, change the other.
 */
const CASES: Array<[string, Partial<Thread>, Kind | undefined]> = [
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

const CODE: Record<Kind, string> = {
  archived: "conflict",
  "rolling-back": "busy",
  "worktree-merged": "conflict",
  "worktree-removed": "conflict",
};

describe("turn.request refusals the composer mirrors (threadSendBlock)", () => {
  it.each(CASES)("%s", (_name, patch, kind) => {
    const result = decide(modelWith(thread(patch)), { type: "turn.request", threadId: "t1", text: "go" }, ctx);
    if (kind === undefined) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, error: { code: CODE[kind] } });
  });

  it("refuses an in-place plan implementation for the same reason", () => {
    const t = thread({ branch: "tide/t1", mergedAt: 5 });
    const base = modelWith(t);
    const model: ReadModel = {
      ...base,
      plans: { pl1: { id: "pl1", threadId: "t1", turnId: "u1", markdown: "# Do", status: "proposed", createdAt: 1, updatedAt: 1 } },
    };
    expect(decide(model, { type: "plan.implement", planId: "pl1" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
