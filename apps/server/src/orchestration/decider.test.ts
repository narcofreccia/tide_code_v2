import { describe, it, expect } from "vitest";
import { emptyReadModel, replay, type Command, type DomainEvent, type ReadModel } from "@tide/contracts";
import { decide } from "./decider.ts";

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

  it("rejects a second turn while one is running", () => {
    const { model, threadId } = withThread();
    const running = run(model, { type: "turn.request", threadId, text: "one" }).model;
    expect(decide(running, { type: "turn.request", threadId, text: "two" }, ctx)).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("rejects a turn on a missing or archived thread", () => {
    expect(decide(emptyReadModel(), { type: "turn.request", threadId: "nope", text: "hi" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const { model, threadId } = withThread();
    const archived = run(model, { type: "thread.archive", threadId }).model;
    expect(decide(archived, { type: "turn.request", threadId, text: "hi" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
