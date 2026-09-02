import { describe, it, expect } from "vitest";
import { emptyReadModel, replay, type Activity, type Command, type DomainEvent, type ReadModel } from "@tide/contracts";
import { decide } from "./index.ts";

let counter = 0;
const ctx = { now: 1000, newId: () => `id${++counter}` };

function apply(model: ReadModel, events: DomainEvent[]): ReadModel {
  return replay(model, events.map((event, i) => ({ seq: model.seq + i + 1, ts: 1000, event })));
}

function run(model: ReadModel, command: Command): { model: ReadModel; events: DomainEvent[] } {
  const result = decide(model, command, ctx);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.code}`);
  return { model: apply(model, result.events), events: result.events };
}

const withProject = (): { model: ReadModel; projectId: string } => {
  const { model, events } = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: "/repo" });
  const created = events[0];
  if (created?.type !== "project.created") throw new Error("expected project.created");
  return { model, projectId: created.project.id };
};

const withThread = (): { model: ReadModel; projectId: string; threadId: string } => {
  const base = withProject();
  const { model, events } = run(base.model, { type: "thread.create", projectId: base.projectId, provider: "claude" });
  const created = events[0];
  if (created?.type !== "thread.created") throw new Error("expected thread.created");
  return { model, projectId: base.projectId, threadId: created.thread.id };
};

describe("decide: projects", () => {
  it("creates a project", () => {
    const { model, projectId } = withProject();
    expect(model.projects[projectId]).toMatchObject({ title: "T", rootPath: "/repo", createdAt: 1000, updatedAt: 1000 });
  });

  it("rejects a duplicate rootPath", () => {
    const { model } = withProject();
    const res = decide(model, { type: "project.create", title: "Other", rootPath: "/repo" }, ctx);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("allows reusing the rootPath of an archived project", () => {
    const { model, projectId } = withProject();
    const archived = run(model, { type: "project.archive", projectId }).model;
    expect(decide(archived, { type: "project.create", title: "Again", rootPath: "/repo" }, ctx).ok).toBe(true);
  });

  it("rejects update/archive of a missing project", () => {
    expect(decide(emptyReadModel(), { type: "project.update", projectId: "nope", title: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(decide(emptyReadModel(), { type: "project.archive", projectId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("updates a project title", () => {
    const { model, projectId } = withProject();
    const next = run(model, { type: "project.update", projectId, title: "Renamed" }).model;
    expect(next.projects[projectId]?.title).toBe("Renamed");
  });

  it("archiving twice is a no-op", () => {
    const { model, projectId } = withProject();
    const archived = run(model, { type: "project.archive", projectId }).model;
    const again = decide(archived, { type: "project.archive", projectId }, ctx);
    expect(again).toEqual({ ok: true, events: [] });
  });
});

describe("decide: threads", () => {
  it("applies defaults", () => {
    const { model, threadId, projectId } = withThread();
    expect(model.threads[threadId]).toMatchObject({
      projectId,
      title: "New thread",
      provider: "claude",
      mode: "approval-required",
      interaction: "default",
      status: "idle",
    });
    expect(model.threads[threadId]?.parentThreadId).toBeUndefined();
  });

  it("honours explicit fields", () => {
    const base = withProject();
    const { model, events } = run(base.model, {
      type: "thread.create",
      projectId: base.projectId,
      provider: "pi",
      title: "Custom",
      model: "opus",
      mode: "auto",
      interaction: "plan",
    });
    const created = events[0];
    if (created?.type !== "thread.created") throw new Error("expected thread.created");
    expect(model.threads[created.thread.id]).toMatchObject({ title: "Custom", provider: "pi", model: "opus", mode: "auto", interaction: "plan" });
  });

  it("rejects a thread on a missing or archived project", () => {
    expect(decide(emptyReadModel(), { type: "thread.create", projectId: "nope", provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const { model, projectId } = withProject();
    const archived = run(model, { type: "project.archive", projectId }).model;
    expect(decide(archived, { type: "thread.create", projectId, provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("requires an existing parent thread", () => {
    const base = withProject();
    expect(decide(base.model, { type: "thread.create", projectId: base.projectId, provider: "claude", parentThreadId: "ghost" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const { model, threadId, projectId } = withThread();
    expect(decide(model, { type: "thread.create", projectId, provider: "claude", parentThreadId: threadId }, ctx).ok).toBe(true);
  });

  it("patches only the provided fields", () => {
    const { model, threadId } = withThread();
    const { events } = run(model, { type: "thread.update", threadId, title: "Renamed" });
    expect(events[0]).toMatchObject({ type: "thread.updated", patch: { title: "Renamed" } });
    const patch = events[0]?.type === "thread.updated" ? events[0].patch : {};
    expect(Object.keys(patch)).toEqual(["title"]);
  });

  it("rejects update/archive of a missing thread", () => {
    expect(decide(emptyReadModel(), { type: "thread.update", threadId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(decide(emptyReadModel(), { type: "thread.archive", threadId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("archives a thread", () => {
    const { model, threadId } = withThread();
    const next = run(model, { type: "thread.archive", threadId }).model;
    expect(next.threads[threadId]?.archivedAt).toBe(1000);
  });
});

describe("decide: turns", () => {
  it("emits turn.requested with the user message", () => {
    const { model, threadId } = withThread();
    const { model: next, events } = run(model, { type: "turn.request", threadId, text: "hello" });
    const evt = events[0];
    if (evt?.type !== "turn.requested") throw new Error("expected turn.requested");
    expect(evt.turn).toMatchObject({ threadId, status: "requested", requestedAt: 1000 });
    expect(evt.userMessage).toMatchObject({ threadId, turnId: evt.turn.id, role: "user", text: "hello" });
    expect(next.threads[threadId]?.status).toBe("running");
  });

  it("queues a second turn while one is running; dequeue drops it", () => {
    const { model, threadId } = withThread();
    const first = run(model, { type: "turn.request", threadId, text: "one" });
    const firstTurn = first.events[0]?.type === "turn.requested" ? first.events[0].turn.id : "";
    const second = run(first.model, { type: "turn.request", threadId, text: "two", images: [{ mediaType: "image/png", data: "AAAA" }] });
    const evt = second.events[0];
    if (evt?.type !== "turn.requested") throw new Error("expected turn.requested");
    expect(evt.turn.status).toBe("queued");
    expect(evt.images).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
    expect(evt.userMessage.attachments).toEqual([{ mediaType: "image/png", bytes: 3 }]);
    expect(second.model.threads[threadId]?.latestTurnId).toBe(firstTurn);
    expect(decide(second.model, { type: "turn.dequeue", turnId: firstTurn }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const dequeued = run(second.model, { type: "turn.dequeue", turnId: evt.turn.id });
    expect(dequeued.events[0]).toMatchObject({ type: "turn.dequeued", turnId: evt.turn.id, threadId });
    expect(dequeued.model.turns[evt.turn.id]).toBeUndefined();
    expect(decide(dequeued.model, { type: "turn.dequeue", turnId: evt.turn.id }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("appends reasoning to the assistant message of a live turn only", () => {
    const { model, threadId } = withThread();
    const { model: live, events } = run(model, { type: "turn.request", threadId, text: "one" });
    const turnId = events[0]?.type === "turn.requested" ? events[0].turn.id : "";
    const next = run(live, { type: "assistant.reasoning.append", turnId, messageId: "a1", delta: "hmm" });
    expect(next.events[0]).toMatchObject({ type: "assistant.reasoning-delta", turnId, threadId, messageId: "a1", delta: "hmm" });
    expect(next.model.messages["a1"]).toMatchObject({ reasoning: "hmm", text: "" });
    const settled = run(next.model, { type: "turn.settle", turnId, status: "completed" }).model;
    expect(decide(settled, { type: "assistant.reasoning.append", turnId, messageId: "a1", delta: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("rejects a turn on a missing or archived thread", () => {
    expect(decide(emptyReadModel(), { type: "turn.request", threadId: "nope", text: "hi" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const { model, threadId } = withThread();
    const archived = run(model, { type: "thread.archive", threadId }).model;
    expect(decide(archived, { type: "turn.request", threadId, text: "hi" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

// ---- P1 vocabulary ----

const withTurn = (): { model: ReadModel; projectId: string; threadId: string; turnId: string } => {
  const base = withThread();
  const { model, events } = run(base.model, { type: "turn.request", threadId: base.threadId, text: "go" });
  const evt = events[0];
  if (evt?.type !== "turn.requested") throw new Error("expected turn.requested");
  return { ...base, model, turnId: evt.turn.id };
};

const started = (): { model: ReadModel; threadId: string; turnId: string; projectId: string } => {
  const base = withTurn();
  const model = run(base.model, { type: "turn.start", turnId: base.turnId, provider: "claude", model: "opus" }).model;
  return { ...base, model };
};

const approvalActivity = (threadId: string, turnId: string, requestId: string): Activity => ({
  id: "act-1",
  threadId,
  turnId,
  kind: "approval",
  requestId,
  toolName: "Bash",
  input: { command: "ls" },
  status: "pending",
  createdAt: 1000,
  updatedAt: 1000,
});

const withPlan = (): { model: ReadModel; threadId: string; turnId: string; planId: string } => {
  const base = started();
  const { model, events } = run(base.model, { type: "plan.propose", turnId: base.turnId, markdown: "## Ship it\n\n- step" });
  const evt = events[0];
  if (evt?.type !== "plan.proposed") throw new Error("expected plan.proposed");
  return { ...base, model, planId: evt.plan.id };
};

describe("decide: turn.interrupt", () => {
  it("requests an interrupt for the live turn", () => {
    const { model, threadId, turnId } = started();
    const { events } = run(model, { type: "turn.interrupt", threadId });
    expect(events[0]).toMatchObject({ type: "turn.interrupt-requested", turnId, threadId, at: 1000 });
  });

  it("works while the turn is still requested", () => {
    const { model, threadId, turnId } = withTurn();
    const { events } = run(model, { type: "turn.interrupt", threadId });
    expect(events[0]).toMatchObject({ type: "turn.interrupt-requested", turnId });
  });

  it("rejects an unknown thread", () => {
    expect(decide(emptyReadModel(), { type: "turn.interrupt", threadId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("rejects an idle thread", () => {
    const { model, threadId } = withThread();
    expect(decide(model, { type: "turn.interrupt", threadId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("rejects once the turn has settled", () => {
    const base = started();
    const settledModel = run(base.model, { type: "turn.settle", turnId: base.turnId, status: "completed" }).model;
    expect(decide(settledModel, { type: "turn.interrupt", threadId: base.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: approval / user-input responses", () => {
  it("resolves a pending approval", () => {
    const base = started();
    const model = run(base.model, { type: "activity.upsert", activity: approvalActivity(base.threadId, base.turnId, "req-1") }).model;
    expect(model.threads[base.threadId]?.attention).toBe("approval");
    const { model: next, events } = run(model, { type: "approval.respond", threadId: base.threadId, requestId: "req-1", decision: "accept" });
    expect(events[0]).toMatchObject({ type: "approval.responded", requestId: "req-1", decision: "accept" });
    expect(next.activities["act-1"]).toMatchObject({ status: "resolved", decision: "accept" });
    expect(next.threads[base.threadId]?.attention).toBeUndefined();
  });

  it("rejects an unknown requestId", () => {
    const { model, threadId } = started();
    expect(decide(model, { type: "approval.respond", threadId, requestId: "ghost", decision: "accept" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(decide(model, { type: "user-input.respond", threadId, requestId: "ghost", answers: {} }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("rejects a second response to the same approval", () => {
    const base = started();
    let model = run(base.model, { type: "activity.upsert", activity: approvalActivity(base.threadId, base.turnId, "req-1") }).model;
    model = run(model, { type: "approval.respond", threadId: base.threadId, requestId: "req-1", decision: "accept" }).model;
    expect(decide(model, { type: "approval.respond", threadId: base.threadId, requestId: "req-1", decision: "decline" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("answers a pending question", () => {
    const base = started();
    const question: Activity = {
      id: "act-q", threadId: base.threadId, turnId: base.turnId, kind: "user-input", requestId: "q-1",
      questions: [{ id: "a", text: "Which framework?" }], status: "pending", createdAt: 1000, updatedAt: 1000,
    };
    const model = run(base.model, { type: "activity.upsert", activity: question }).model;
    expect(model.threads[base.threadId]?.attention).toBe("question");
    const { model: next } = run(model, { type: "user-input.respond", threadId: base.threadId, requestId: "q-1", answers: { a: "vite" } });
    expect(next.activities["act-q"]).toMatchObject({ status: "resolved", answers: { a: "vite" } });
  });
});

describe("decide: internal turn commands", () => {
  it("starts the latest turn once", () => {
    const base = withTurn();
    const { model, events } = run(base.model, { type: "turn.start", turnId: base.turnId, provider: "claude", model: "opus", nativeSessionId: "sess-1" });
    expect(events[0]).toMatchObject({ type: "turn.started", turnId: base.turnId, provider: "claude", model: "opus", nativeSessionId: "sess-1" });
    expect(model.turns[base.turnId]?.status).toBe("running");
    expect(model.threads[base.threadId]?.nativeSessionId).toBe("sess-1");
    expect(decide(model, { type: "turn.start", turnId: base.turnId, provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("rejects starting an unknown turn", () => {
    expect(decide(emptyReadModel(), { type: "turn.start", turnId: "nope", provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("rejects starting a turn that is no longer the latest", () => {
    const base = withTurn();
    let model = run(base.model, { type: "turn.settle", turnId: base.turnId, status: "completed" }).model;
    const second = run(model, { type: "turn.request", threadId: base.threadId, text: "again" });
    model = second.model;
    expect(decide(model, { type: "turn.start", turnId: base.turnId, provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("appends assistant deltas into one message", () => {
    const base = started();
    let model = run(base.model, { type: "assistant.append", turnId: base.turnId, messageId: "m1", delta: "Hel" }).model;
    model = run(model, { type: "assistant.append", turnId: base.turnId, messageId: "m1", delta: "lo" }).model;
    expect(model.messages["m1"]).toMatchObject({ text: "Hello", role: "assistant", streaming: true });
    expect(model.threadMessages[base.threadId]).toHaveLength(2);
  });

  it("rejects deltas for an unknown or settled turn", () => {
    const base = started();
    expect(decide(base.model, { type: "assistant.append", turnId: "nope", messageId: "m", delta: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const settledModel = run(base.model, { type: "turn.settle", turnId: base.turnId, status: "completed" }).model;
    expect(decide(settledModel, { type: "assistant.append", turnId: base.turnId, messageId: "m", delta: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("records usage on the turn and cost on the thread", () => {
    const base = started();
    const { model } = run(base.model, {
      type: "usage.report", turnId: base.turnId,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
      contextUsage: { used: 1000, window: 200000 },
    });
    expect(model.turns[base.turnId]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(model.threads[base.threadId]).toMatchObject({ totalCostUsd: 0.25, contextUsage: { used: 1000, window: 200000 } });
  });

  it("settles a turn exactly once", () => {
    const base = started();
    const { model, events } = run(base.model, { type: "turn.settle", turnId: base.turnId, status: "error", error: "boom" });
    expect(events[0]).toMatchObject({ type: "turn.settled", status: "error", error: "boom" });
    expect(model.threads[base.threadId]?.status).toBe("error");
    expect(decide(model, { type: "turn.settle", turnId: base.turnId, status: "completed" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("rejects settling an unknown turn", () => {
    expect(decide(emptyReadModel(), { type: "turn.settle", turnId: "nope", status: "completed" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("decide: activity.upsert", () => {
  it("inserts then updates the same row", () => {
    const base = started();
    const tool: Activity = {
      id: "t1", threadId: base.threadId, turnId: base.turnId, kind: "tool", toolUseId: "tu1",
      toolName: "Read", input: { path: "a.ts" }, status: "running", createdAt: 1000, updatedAt: 1000,
    };
    let model = run(base.model, { type: "activity.upsert", activity: tool }).model;
    model = run(model, { type: "activity.upsert", activity: { ...tool, status: "ok", output: "done" } }).model;
    expect(model.activities["t1"]).toMatchObject({ status: "ok", output: "done" });
    expect(model.threadTimeline[base.threadId]?.filter((e) => e.kind === "activity")).toHaveLength(1);
  });

  it("rejects an unknown turn or a mismatched thread", () => {
    const base = started();
    const bad: Activity = { id: "x", threadId: base.threadId, turnId: "ghost", kind: "info", text: "hi", createdAt: 1000, updatedAt: 1000 };
    expect(decide(base.model, { type: "activity.upsert", activity: bad }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const other = run(base.model, { type: "thread.create", projectId: base.projectId, provider: "claude" });
    const createdThread = other.events[0];
    if (createdThread?.type !== "thread.created") throw new Error("expected thread.created");
    const crossed: Activity = { id: "y", threadId: createdThread.thread.id, turnId: base.turnId, kind: "info", text: "hi", createdAt: 1000, updatedAt: 1000 };
    expect(decide(other.model, { type: "activity.upsert", activity: crossed }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: plans", () => {
  it("proposes a plan and raises plan attention", () => {
    const { model, planId, threadId, turnId } = withPlan();
    expect(model.plans[planId]).toMatchObject({ threadId, turnId, status: "proposed", markdown: "## Ship it\n\n- step" });
    expect(model.threads[threadId]?.attention).toBe("plan");
  });

  it("rejects a plan on an unknown turn", () => {
    expect(decide(emptyReadModel(), { type: "plan.propose", turnId: "nope", markdown: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("records plan progress on the thread", () => {
    const base = started();
    const { model } = run(base.model, { type: "plan.progress", threadId: base.threadId, steps: [{ text: "one", status: "in_progress" }] });
    expect(model.threads[base.threadId]?.planProgress).toMatchObject({ steps: [{ text: "one", status: "in_progress" }], updatedAt: 1000 });
    expect(decide(base.model, { type: "plan.progress", threadId: "nope", steps: [] }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("implements a plan into a sibling thread with a seeded turn", () => {
    const base = withPlan();
    const settledModel = run(base.model, { type: "turn.settle", turnId: base.turnId, status: "completed" }).model;
    const { model, events } = run(settledModel, { type: "plan.implement", planId: base.planId, provider: "codex", model: "gpt-5", mode: "auto" });
    expect(events.map((e) => e.type)).toEqual(["thread.created", "turn.requested", "plan.updated"]);
    const created = events[0];
    if (created?.type !== "thread.created") throw new Error("expected thread.created");
    expect(created.thread).toMatchObject({
      projectId: base.model.threads[base.threadId]?.projectId,
      parentThreadId: base.threadId,
      title: "Ship it",
      provider: "codex",
      model: "gpt-5",
      mode: "auto",
      interaction: "default",
    });
    const requested = events[1];
    if (requested?.type !== "turn.requested") throw new Error("expected turn.requested");
    expect(requested.turn).toMatchObject({ threadId: created.thread.id, status: "requested" });
    expect(requested.userMessage.text).toBe("Implement the following plan.\n\n## Ship it\n\n- step");
    expect(model.plans[base.planId]).toMatchObject({ status: "implemented", implementationThreadId: created.thread.id });
    expect(model.threads[base.threadId]?.attention).toBeUndefined();
    expect(model.threads[created.thread.id]?.status).toBe("running");
  });

  it("falls back to a default title when the plan has no heading", () => {
    const base = started();
    const proposed = run(base.model, { type: "plan.propose", turnId: base.turnId, markdown: "just prose" });
    const evt = proposed.events[0];
    if (evt?.type !== "plan.proposed") throw new Error("expected plan.proposed");
    const { events } = run(proposed.model, { type: "plan.implement", planId: evt.plan.id, provider: "claude" });
    const created = events[0];
    if (created?.type !== "thread.created") throw new Error("expected thread.created");
    expect(created.thread.title).toBe("Implement plan");
    expect(created.thread.mode).toBe("approval-required");
  });

  it("rejects implementing an unknown or non-proposed plan", () => {
    expect(decide(emptyReadModel(), { type: "plan.implement", planId: "nope", provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const base = withPlan();
    const dismissed = run(base.model, { type: "plan.dismiss", planId: base.planId }).model;
    expect(decide(dismissed, { type: "plan.implement", planId: base.planId, provider: "claude" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("dismisses a plan, idempotently", () => {
    const base = withPlan();
    const { model, events } = run(base.model, { type: "plan.dismiss", planId: base.planId });
    expect(events[0]).toMatchObject({ type: "plan.updated", status: "dismissed" });
    expect(model.threads[base.threadId]?.attention).toBeUndefined();
    expect(decide(model, { type: "plan.dismiss", planId: base.planId }, ctx)).toEqual({ ok: true, events: [] });
  });

  it("rejects dismissing an implemented plan", () => {
    const base = withPlan();
    const settledModel = run(base.model, { type: "turn.settle", turnId: base.turnId, status: "completed" }).model;
    const implemented = run(settledModel, { type: "plan.implement", planId: base.planId, provider: "claude" }).model;
    expect(decide(implemented, { type: "plan.dismiss", planId: base.planId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(decide(emptyReadModel(), { type: "plan.dismiss", planId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
