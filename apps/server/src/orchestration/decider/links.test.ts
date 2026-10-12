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

/** A project with one write link (`frontend`) and one read-only link (`infra`). */
function withLinks(): { model: ReadModel; projectId: string; frontend: string; infra: string } {
  const created = run(emptyReadModel(), { type: "project.create", title: "API", rootPath: "/repos/api" });
  const projectId = created.events[0]?.type === "project.created" ? created.events[0].project.id : "";
  let model = created.model;
  model = run(model, { type: "project.link.add", projectId, path: "/repos/frontend", label: "frontend", note: "React web client" }).model;
  model = run(model, { type: "project.link.add", projectId, path: "/repos/infra/", label: "infra", access: "read" }).model;
  const links = model.projects[projectId]?.links ?? [];
  return { model, projectId, frontend: links[0]!.id, infra: links[1]!.id };
}

describe("decide: project links", () => {
  it("adds a link, defaulting access to write and normalising the path", () => {
    const { model, projectId } = withLinks();
    expect(model.projects[projectId]?.links).toEqual([
      { id: "id2", path: "/repos/frontend", label: "frontend", note: "React web client", access: "write" },
      { id: "id3", path: "/repos/infra", label: "infra", access: "read" },
    ]);
    expect(model.projects[projectId]?.updatedAt).toBe(1000);
  });

  it("requires an absolute path and a non-empty label", () => {
    const { model, projectId } = withLinks();
    expect(decide(model, { type: "project.link.add", projectId, path: "../elsewhere", label: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/other", label: "   " }, ctx)).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });

  it("refuses the project's own root, however it is spelled", () => {
    const { model, projectId } = withLinks();
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/api", label: "self" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/api/", label: "self" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/api/sub/..", label: "self" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("allows a link that is a subdirectory of the project root", () => {
    const { model, projectId } = withLinks();
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/api/vendor", label: "vendor" }, ctx).ok).toBe(true);
  });

  it("refuses a duplicate path, comparing normalised paths", () => {
    const { model, projectId } = withLinks();
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/frontend/", label: "again" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(decide(model, { type: "project.link.add", projectId, path: "/repos/./frontend", label: "again" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("updates only the fields given, and rejects an unknown link", () => {
    const { model, projectId, infra } = withLinks();
    const next = run(model, { type: "project.link.update", projectId, linkId: infra, access: "write", note: "Terraform" }).model;
    expect(next.projects[projectId]?.links?.find((l) => l.id === infra)).toEqual({ id: infra, path: "/repos/infra", label: "infra", note: "Terraform", access: "write" });
    expect(decide(model, { type: "project.link.update", projectId, linkId: "ghost", label: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(decide(model, { type: "project.link.update", projectId, linkId: infra, label: " " }, ctx)).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });

  it("removes a link, and removing it again is a no-op", () => {
    const { model, projectId, frontend } = withLinks();
    const next = run(model, { type: "project.link.remove", projectId, linkId: frontend }).model;
    expect(next.projects[projectId]?.links?.map((l) => l.label)).toEqual(["infra"]);
    expect(decide(next, { type: "project.link.remove", projectId, linkId: frontend }, ctx)).toEqual({ ok: true, events: [] });
  });

  it("rejects link commands on an unknown or archived project", () => {
    const { model, projectId } = withLinks();
    expect(decide(model, { type: "project.link.add", projectId: "ghost", path: "/x", label: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
    const archived = run(model, { type: "project.archive", projectId }).model;
    expect(decide(archived, { type: "project.link.add", projectId, path: "/x", label: "x" }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: thread links", () => {
  it("inherits every project link at its default access", () => {
    const { model, projectId, frontend, infra } = withLinks();
    const created = run(model, { type: "thread.create", projectId, provider: "claude" });
    const thread = created.events[0]?.type === "thread.created" ? created.events[0].thread : undefined;
    expect(thread?.links).toEqual([
      { linkId: frontend, access: "write" },
      { linkId: infra, access: "read" },
    ]);
  });

  it("honours per-thread overrides, and an explicit empty list means no links", () => {
    const { model, projectId, frontend } = withLinks();
    const one = run(model, { type: "thread.create", projectId, provider: "codex", links: [{ linkId: frontend, access: "read" }] });
    expect(one.events[0]?.type === "thread.created" && one.events[0].thread.links).toEqual([{ linkId: frontend, access: "read" }]);
    const none = run(model, { type: "thread.create", projectId, provider: "codex", links: [] });
    expect(none.events[0]?.type === "thread.created" && none.events[0].thread.links).toEqual([]);
  });

  it("never lets an override widen a read-only project link", () => {
    const { model, projectId, infra } = withLinks();
    const created = run(model, { type: "thread.create", projectId, provider: "pi", links: [{ linkId: infra, access: "write" }] });
    expect(created.events[0]?.type === "thread.created" && created.events[0].thread.links).toEqual([{ linkId: infra, access: "read" }]);
  });

  it("rejects an override naming a link the project does not have", () => {
    const { model, projectId } = withLinks();
    expect(decide(model, { type: "thread.create", projectId, provider: "claude", links: [{ linkId: "ghost", access: "write" }] }, ctx)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });

  it("leaves links off a thread in a project that has none", () => {
    const created = run(emptyReadModel(), { type: "project.create", title: "Solo", rootPath: "/repos/solo" });
    const projectId = created.events[0]?.type === "project.created" ? created.events[0].project.id : "";
    const thread = run(created.model, { type: "thread.create", projectId, provider: "claude" });
    expect(thread.events[0]?.type === "thread.created" && thread.events[0].thread.links).toBeUndefined();
  });
});

describe("decide: delegation into a linked repo", () => {
  const seed = (): { model: ReadModel; projectId: string; threadId: string } => {
    const base = withLinks();
    const created = run(base.model, { type: "thread.create", projectId: base.projectId, provider: "claude" });
    const threadId = created.events[0]?.type === "thread.created" ? created.events[0].thread.id : "";
    return { model: created.model, projectId: base.projectId, threadId };
  };

  it("creates a project for the linked repo and runs the delegate there, with no links of its own", () => {
    const { model, threadId } = seed();
    const { events } = run(model, { type: "thread.delegate", fromThreadId: threadId, provider: "codex", prompt: "ship it", repo: "frontend" });
    const project = events.find((e) => e.type === "project.created");
    expect(project?.type === "project.created" && project.project).toMatchObject({ title: "frontend", rootPath: "/repos/frontend" });
    const thread = events.find((e) => e.type === "thread.created");
    expect(thread?.type === "thread.created" && thread.thread.projectId).toBe(project?.type === "project.created" ? project.project.id : "");
    expect(thread?.type === "thread.created" && thread.thread.links).toBeUndefined();
  });

  it("reuses an existing non-archived project for that path instead of making a second one", () => {
    const { model, threadId } = seed();
    const existing = run(model, { type: "project.create", title: "Web", rootPath: "/repos/frontend" });
    const projectId = existing.events[0]?.type === "project.created" ? existing.events[0].project.id : "";
    const { events } = run(existing.model, { type: "thread.delegate", fromThreadId: threadId, provider: "opencode", prompt: "ship it", repo: "frontend" });
    expect(events.some((e) => e.type === "project.created")).toBe(false);
    const thread = events.find((e) => e.type === "thread.created");
    expect(thread?.type === "thread.created" && thread.thread.projectId).toBe(projectId);
  });

  it("matches the label case-insensitively and rejects an unknown one", () => {
    const { model, threadId } = seed();
    expect(decide(model, { type: "thread.delegate", fromThreadId: threadId, provider: "codex", prompt: "x", repo: "FrontEnd" }, ctx).ok).toBe(true);
    expect(decide(model, { type: "thread.delegate", fromThreadId: threadId, provider: "codex", prompt: "x", repo: "nope" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });

  it("refuses a read-only link as the delegate's main repo", () => {
    const { model, threadId } = seed();
    expect(decide(model, { type: "thread.delegate", fromThreadId: threadId, provider: "codex", prompt: "x", repo: "infra" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "invalid-command", message: expect.stringContaining("read-only") },
    });
  });

  it("stays in the caller's own project when no repo is named", () => {
    const { model, threadId, projectId } = seed();
    const { events } = run(model, { type: "thread.delegate", fromThreadId: threadId, provider: "codex", prompt: "x" });
    expect(events.some((e) => e.type === "project.created")).toBe(false);
    const thread = events.find((e) => e.type === "thread.created");
    expect(thread?.type === "thread.created" && thread.thread.projectId).toBe(projectId);
  });
});

describe("decide: delegation privileges", () => {
  /** A parent thread created with `mode`, ready to delegate. */
  const parent = (mode: "approval-required" | "auto-accept-edits" | "auto" | "full-access"): { model: ReadModel; threadId: string } => {
    const base = withLinks();
    const created = run(base.model, { type: "thread.create", projectId: base.projectId, provider: "claude", mode });
    return { model: created.model, threadId: created.events[0]?.type === "thread.created" ? created.events[0].thread.id : "" };
  };

  const delegatedMode = (model: ReadModel, threadId: string, mode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access"): string => {
    const { events } = run(model, { type: "thread.delegate", fromThreadId: threadId, provider: "codex", prompt: "x", ...(mode !== undefined ? { mode } : {}) });
    const thread = events.find((e) => e.type === "thread.created");
    return thread?.type === "thread.created" ? thread.thread.mode : "";
  };

  it("never lets a delegate be more privileged than the thread that spawned it", () => {
    const p = parent("approval-required");
    expect(delegatedMode(p.model, p.threadId, "full-access")).toBe("approval-required");
    expect(delegatedMode(p.model, p.threadId, "auto")).toBe("approval-required");
  });

  it("honours a mode at or below the parent's, and inherits it when none is asked for", () => {
    const p = parent("full-access");
    expect(delegatedMode(p.model, p.threadId, "auto")).toBe("auto");
    expect(delegatedMode(p.model, p.threadId)).toBe("full-access");
    const q = parent("auto-accept-edits");
    expect(delegatedMode(q.model, q.threadId)).toBe("auto-accept-edits");
    expect(delegatedMode(q.model, q.threadId, "approval-required")).toBe("approval-required");
  });

  it("accepts pi as a delegate (driver-pi 1.1 attaches the Tide MCP server natively)", () => {
    const p = parent("auto");
    expect(decide(p.model, { type: "thread.delegate", fromThreadId: p.threadId, provider: "pi", prompt: "x" }, ctx).ok).toBe(true);
  });
});
