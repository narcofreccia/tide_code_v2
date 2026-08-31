import { describe, expect, it } from "vitest";
import { emptyReadModel, replay, type Command, type DomainEvent, type ReadModel } from "@tide/contracts";
import { decide } from "./index.ts";

let counter = 0;
const ctx = { now: 1000, newId: () => `id${++counter}` };

function apply(model: ReadModel, events: DomainEvent[]): ReadModel {
  return replay(model, events.map((event, i) => ({ seq: model.seq + i + 1, ts: 1000, event })));
}
function run(model: ReadModel, command: Command): { model: ReadModel; events: DomainEvent[] } {
  const result = decide(model, command, ctx);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.code} ${result.error.message}`);
  return { model: apply(model, result.events), events: result.events };
}

interface Fixture {
  model: ReadModel;
  projectId: string;
  threadId: string;
}

function withThread(useWorktree = false): Fixture {
  const created = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: "/repo" });
  const project = created.events[0];
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const t = run(created.model, {
    type: "thread.create",
    projectId: project.project.id,
    provider: "claude",
    ...(useWorktree ? { useWorktree: true } : {}),
  });
  const thread = t.events[0];
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");
  return { model: t.model, projectId: project.project.id, threadId: thread.thread.id };
}

/** A thread with one settled turn that carries a before-checkpoint. */
function withCheckpointedTurn(): Fixture & { turnId: string } {
  const base = withThread();
  const requested = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go" });
  const event = requested.events[0];
  if (event?.type !== "turn.requested") throw new Error("expected turn.requested");
  const turnId = event.turn.id;
  let model = run(requested.model, { type: "checkpoint.record", turnId, phase: "before", ref: "refs/tide/before" }).model;
  model = run(model, { type: "turn.start", turnId, provider: "claude" }).model;
  model = run(model, { type: "turn.settle", turnId, status: "completed" }).model;
  return { ...base, model, turnId };
}

describe("decide: thread.created carries useWorktree", () => {
  it("passes the intent flag through to the event", () => {
    const base = withThread(true);
    const thread = base.model.threads[base.threadId];
    expect(thread?.worktreePath).toBeUndefined(); // intent only; the reactor answers with worktree.attached
  });
});

describe("decide: worktree.attach", () => {
  it("attaches path, branch and base branch", () => {
    const base = withThread();
    const { model, events } = run(base.model, {
      type: "worktree.attach",
      threadId: base.threadId,
      worktreePath: "/wt/abc",
      branch: "tide/feature",
      baseBranch: "main",
    });
    expect(events[0]).toMatchObject({ type: "worktree.attached", worktreePath: "/wt/abc", branch: "tide/feature", baseBranch: "main", at: 1000 });
    expect(model.threads[base.threadId]).toMatchObject({ worktreePath: "/wt/abc", branch: "tide/feature", baseBranch: "main" });
  });

  it("rejects an unknown thread", () => {
    expect(decide(emptyReadModel(), { type: "worktree.attach", threadId: "nope", worktreePath: "/x", branch: "b" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });
});

describe("decide: checkpoint.record", () => {
  it("records before then after with stats", () => {
    const base = withThread();
    const requested = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go" });
    const event = requested.events[0];
    if (event?.type !== "turn.requested") throw new Error("expected turn.requested");
    const turnId = event.turn.id;

    const before = run(requested.model, { type: "checkpoint.record", turnId, phase: "before", ref: "refs/before" });
    expect(before.events[0]).toMatchObject({ type: "checkpoint.recorded", threadId: base.threadId, phase: "before" });
    expect(before.model.turns[turnId]?.checkpoint).toEqual({ before: "refs/before" });

    const stats = { files: 2, additions: 10, deletions: 3 };
    const after = run(before.model, { type: "checkpoint.record", turnId, phase: "after", ref: "refs/after", stats });
    expect(after.model.turns[turnId]?.checkpoint).toEqual({ before: "refs/before", after: "refs/after", stats });
  });

  it("rejects an unknown turn", () => {
    expect(decide(emptyReadModel(), { type: "checkpoint.record", turnId: "nope", phase: "before", ref: "r" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });
});

describe("decide: thread.revert", () => {
  it("requests a revert for a checkpointed turn on an idle thread", () => {
    const f = withCheckpointedTurn();
    const { events } = run(f.model, { type: "thread.revert", threadId: f.threadId, turnId: f.turnId });
    expect(events[0]).toMatchObject({ type: "revert.requested", threadId: f.threadId, turnId: f.turnId, at: 1000 });
  });

  it("rejects an unknown thread or turn", () => {
    const f = withCheckpointedTurn();
    expect(decide(f.model, { type: "thread.revert", threadId: "nope", turnId: f.turnId }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(decide(f.model, { type: "thread.revert", threadId: f.threadId, turnId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("rejects a turn without a before-checkpoint", () => {
    const base = withThread();
    const requested = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go" });
    const event = requested.events[0];
    if (event?.type !== "turn.requested") throw new Error("expected turn.requested");
    const settled = run(requested.model, { type: "turn.settle", turnId: event.turn.id, status: "completed" }).model;
    expect(decide(settled, { type: "thread.revert", threadId: base.threadId, turnId: event.turn.id }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("rejects a turn belonging to another thread", () => {
    const a = withCheckpointedTurn();
    const b = run(a.model, { type: "thread.create", projectId: a.projectId, provider: "claude" });
    const other = b.events[0];
    if (other?.type !== "thread.created") throw new Error("expected thread.created");
    expect(decide(b.model, { type: "thread.revert", threadId: other.thread.id, turnId: a.turnId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("is busy while the thread is running", () => {
    const f = withCheckpointedTurn();
    const running = run(f.model, { type: "turn.request", threadId: f.threadId, text: "again" });
    expect(decide(running.model, { type: "thread.revert", threadId: f.threadId, turnId: f.turnId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
  });
});

describe("decide: thread.publish", () => {
  it("requests a publish with title, body and commitOnly", () => {
    const f = withCheckpointedTurn();
    const { events } = run(f.model, { type: "thread.publish", threadId: f.threadId, title: "feat: x", body: "why", commitOnly: true });
    expect(events[0]).toMatchObject({ type: "publish.requested", threadId: f.threadId, title: "feat: x", body: "why", commitOnly: true });
  });

  it("rejects unknown, archived and running threads", () => {
    const f = withCheckpointedTurn();
    expect(decide(f.model, { type: "thread.publish", threadId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const running = run(f.model, { type: "turn.request", threadId: f.threadId, text: "again" }).model;
    expect(decide(running, { type: "thread.publish", threadId: f.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "busy" } });
    const archived = run(f.model, { type: "thread.archive", threadId: f.threadId }).model;
    expect(decide(archived, { type: "thread.publish", threadId: f.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: pr.update", () => {
  it("stores the pull request on the thread", () => {
    const f = withCheckpointedTurn();
    const pr = { url: "https://github.com/o/r/pull/7", number: 7, state: "open" as const, updatedAt: 2000 };
    const { model, events } = run(f.model, { type: "pr.update", threadId: f.threadId, pr });
    expect(events[0]).toMatchObject({ type: "pr.updated", threadId: f.threadId, pr });
    expect(model.threads[f.threadId]?.pr).toEqual(pr);
  });

  it("rejects an unknown thread", () => {
    const pr = { url: "u", number: 1, state: "open" as const, updatedAt: 1 };
    expect(decide(emptyReadModel(), { type: "pr.update", threadId: "nope", pr }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("decide: thread.archive carries keepWorktree", () => {
  it("omits the flag when the client did not send one", () => {
    const f = withThread();
    const { events } = run(f.model, { type: "thread.archive", threadId: f.threadId });
    expect(events[0]).toMatchObject({ type: "thread.archived", threadId: f.threadId });
    expect(events[0]).not.toHaveProperty("keepWorktree");
  });

  it("passes keepWorktree through in both directions", () => {
    for (const keepWorktree of [true, false]) {
      const f = withThread();
      const { events } = run(f.model, { type: "thread.archive", threadId: f.threadId, keepWorktree });
      expect(events[0]).toMatchObject({ type: "thread.archived", keepWorktree });
    }
  });
});

/** A thread whose worktree the reactor has already reported as attached. */
function withAttachedWorktree(): Fixture {
  const base = withThread(true);
  const model = run(base.model, {
    type: "worktree.attach",
    threadId: base.threadId,
    worktreePath: "/wt/thread",
    branch: "tide/fix-login",
    baseBranch: "main",
  }).model;
  return { ...base, model };
}

describe("decide: worktree.detach", () => {
  it("requests a detach for a thread that has a worktree", () => {
    const f = withAttachedWorktree();
    const { model, events } = run(f.model, { type: "worktree.detach", threadId: f.threadId, deleteBranch: true });
    expect(events[0]).toMatchObject({ type: "worktree.detach-requested", threadId: f.threadId, deleteBranch: true, at: 1000 });
    // intent only: the path stays until the reactor reports back
    expect(model.threads[f.threadId]?.worktreePath).toBe("/wt/thread");
  });

  it("omits deleteBranch when unset", () => {
    const f = withAttachedWorktree();
    const { events } = run(f.model, { type: "worktree.detach", threadId: f.threadId });
    expect(events[0]).not.toHaveProperty("deleteBranch");
  });

  it("rejects an unknown thread", () => {
    expect(decide(emptyReadModel(), { type: "worktree.detach", threadId: "nope" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });

  it("rejects a thread with no worktree", () => {
    const f = withThread();
    expect(decide(f.model, { type: "worktree.detach", threadId: f.threadId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("refuses while the thread is running", () => {
    const f = withAttachedWorktree();
    const running = run(f.model, { type: "turn.request", threadId: f.threadId, text: "go" }).model;
    expect(decide(running, { type: "worktree.detach", threadId: f.threadId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
  });
});

describe("decide: worktree.detached", () => {
  it("clears the worktree path and is a no-op once detached", () => {
    const f = withAttachedWorktree();
    const first = decide(f.model, { type: "worktree.detached", threadId: f.threadId }, ctx);
    if (!first.ok) throw new Error("expected ok");
    expect(first.events[0]).toMatchObject({ type: "worktree.detached", threadId: f.threadId });
    const detached = apply(f.model, first.events);
    expect(detached.threads[f.threadId]?.worktreePath).toBeUndefined();
    expect(decide(detached, { type: "worktree.detached", threadId: f.threadId }, ctx)).toMatchObject({ ok: true, events: [] });
  });

  it("rejects an unknown thread", () => {
    expect(decide(emptyReadModel(), { type: "worktree.detached", threadId: "nope" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });
});
