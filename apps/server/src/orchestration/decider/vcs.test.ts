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

/** A thread with one settled turn that carries a before-checkpoint, on a worktree by default. */
function withCheckpointedTurn(worktree = true): Fixture & { turnId: string } {
  const base = worktree ? withAttachedWorktree() : withThread();
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

  it("refuses a thread that has no worktree: the checkout would be the user's own", () => {
    const f = withCheckpointedTurn(false);
    expect(decide(f.model, { type: "thread.revert", threadId: f.threadId, turnId: f.turnId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringContaining("main checkout") },
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

  it("refuses a thread that has no worktree: it would commit and push the user's own branch", () => {
    const f = withCheckpointedTurn(false);
    expect(decide(f.model, { type: "thread.publish", threadId: f.threadId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringContaining("main checkout") },
    });
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

  it("refuses to archive a running thread: the worktree would go under a live harness", () => {
    const f = withThread(true);
    const running = run(f.model, { type: "turn.request", threadId: f.threadId, text: "go" }).model;
    expect(decide(running, { type: "thread.archive", threadId: f.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("passes keepWorktree through in both directions", () => {
    for (const keepWorktree of [true, false]) {
      const f = withThread();
      const { events } = run(f.model, { type: "thread.archive", threadId: f.threadId, keepWorktree });
      expect(events[0]).toMatchObject({ type: "thread.archived", keepWorktree });
    }
  });
});

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

describe("decide: R3 — request ids, late prompts, provider switch, merge-back", () => {
  it("rejects a turn.request that repeats a requestId on the same thread", () => {
    const base = withThread();
    const first = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go", requestId: "req-1" });
    const dup = decide(first.model, { type: "turn.request", threadId: base.threadId, text: "go again", requestId: "req-1" }, ctx);
    expect(dup).toMatchObject({ ok: false, error: { code: "conflict" } });
    const other = withThread();
    expect(decide(other.model, { type: "turn.request", threadId: other.threadId, text: "go", requestId: "req-1" }, ctx).ok).toBe(true);
  });
  it("refuses to run a thread whose worktree was detached", () => {
    const base = withAttachedWorktree();
    const detached = run(base.model, { type: "worktree.detached", threadId: base.threadId }).model;
    expect(decide(detached, { type: "turn.request", threadId: base.threadId, text: "go" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("drops a late pending approval on a settled turn", () => {
    const f = withCheckpointedTurn();
    const late = decide(f.model, {
      type: "activity.upsert",
      activity: { id: "late", kind: "approval", threadId: f.threadId, turnId: f.turnId, requestId: "9", toolName: "Bash", input: {}, status: "pending", createdAt: 1, updatedAt: 1 },
    }, ctx);
    expect(late).toMatchObject({ ok: false, error: { code: "conflict" } });
    const tool = decide(f.model, {
      type: "activity.upsert",
      activity: { id: "tool", kind: "tool", threadId: f.threadId, turnId: f.turnId, toolUseId: "x", toolName: "Read", input: {}, status: "ok", createdAt: 1, updatedAt: 1 },
    }, ctx);
    expect(tool.ok).toBe(true);
  });
  it("a repeated requestId answers the newest pending approval and pins it by activityId", () => {
    const base = withThread();
    const requested = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go" });
    const ev = requested.events[0];
    if (ev?.type !== "turn.requested") throw new Error("expected turn.requested");
    const turnId = ev.turn.id;
    let model = run(requested.model, { type: "turn.start", turnId, provider: "codex" }).model;
    const approval = (id: string) => ({ id, kind: "approval" as const, threadId: base.threadId, turnId, requestId: "0", toolName: "Bash", input: {}, status: "pending" as const, createdAt: 1, updatedAt: 1 });
    model = run(model, { type: "activity.upsert", activity: approval("a1") }).model;
    model = run(model, { type: "approval.respond", threadId: base.threadId, requestId: "0", decision: "accept" }).model;
    model = run(model, { type: "activity.upsert", activity: approval("a2") }).model;
    const second = run(model, { type: "approval.respond", threadId: base.threadId, requestId: "0", decision: "decline" });
    expect(second.events[0]).toMatchObject({ type: "approval.responded", activityId: "a2", decision: "decline" });
    expect(second.model.activities["a2"]).toMatchObject({ status: "resolved", decision: "decline" });
    expect(second.model.activities["a1"]).toMatchObject({ decision: "accept" });
  });
  it("switching provider clears the native session id and is refused while running", () => {
    const base = withThread();
    const requested = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go" });
    const ev = requested.events[0];
    if (ev?.type !== "turn.requested") throw new Error("expected turn.requested");
    let model = run(requested.model, { type: "turn.start", turnId: ev.turn.id, provider: "claude", nativeSessionId: "claude-sess" }).model;
    expect(decide(model, { type: "thread.update", threadId: base.threadId, provider: "codex" }, ctx)).toMatchObject({ ok: false, error: { code: "busy" } });
    model = run(model, { type: "turn.settle", turnId: ev.turn.id, status: "completed" }).model;
    const sameProvider = run(model, { type: "thread.update", threadId: base.threadId, model: "opus" });
    expect(sameProvider.events[0]).not.toHaveProperty("clearNativeSession");
    const switched = run(model, { type: "thread.update", threadId: base.threadId, provider: "codex" });
    expect(switched.events[0]).toMatchObject({ type: "thread.updated", clearNativeSession: true });
    expect(switched.model.threads[base.threadId]?.nativeSessionId).toBeUndefined();
  });
  it("merge-back: requires a branch, defaults to squash, reports once, refuses a second merge", () => {
    const plain = withThread();
    expect(decide(plain.model, { type: "thread.merge", threadId: plain.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const wt = withAttachedWorktree();
    const requested = run(wt.model, { type: "thread.merge", threadId: wt.threadId, deleteBranch: true });
    expect(requested.events[0]).toMatchObject({ type: "merge.requested", strategy: "squash", deleteBranch: true });
    expect(decide(requested.model, { type: "thread.merge", threadId: wt.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "busy" } });
    const conflicted = run(requested.model, { type: "merge.report", threadId: wt.threadId, outcome: "conflicted", files: ["a.ts"] });
    expect(conflicted.events[0]).toMatchObject({ type: "merge.conflicted", files: ["a.ts"], strategy: "squash" });
    expect(decide(conflicted.model, { type: "merge.report", threadId: wt.threadId, outcome: "merged" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const retry = run(conflicted.model, { type: "thread.merge", threadId: wt.threadId, strategy: "rebase" });
    const merged = run(retry.model, { type: "merge.report", threadId: wt.threadId, outcome: "merged", sha: "abc", branchDeleted: true });
    expect(merged.events[0]).toMatchObject({ type: "merge.completed", strategy: "rebase", sha: "abc", branchDeleted: true });
    expect(merged.model.threads[wt.threadId]?.mergedAt).toBe(1000);
    expect(decide(merged.model, { type: "thread.merge", threadId: wt.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("publish carries mergeWhenGreen; triage lands on the thread", () => {
    const wt = withAttachedWorktree();
    const pub = run(wt.model, { type: "thread.publish", threadId: wt.threadId, mergeWhenGreen: "squash" });
    expect(pub.events[0]).toMatchObject({ type: "publish.requested", mergeWhenGreen: "squash" });
    const triaged = run(wt.model, { type: "thread.triage", threadId: wt.threadId, triage: { needsUser: 0.2, stuck: 0.8, urgency: 0.6, at: 5 } });
    expect(triaged.model.threads[wt.threadId]?.triage?.stuck).toBe(0.8);
  });
});
