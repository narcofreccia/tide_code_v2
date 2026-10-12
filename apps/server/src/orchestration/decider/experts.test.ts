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

interface Panel {
  model: ReadModel;
  projectId: string;
  sessionId: string;
}

function withSession(): Panel {
  const created = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: "/repo" });
  const project = created.events[0];
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const session = run(created.model, {
    type: "experts.create",
    projectId: project.project.id,
    topic: "How should we cache?",
    experts: [
      { key: "perf", name: "Pat", role: "performance", provider: "claude" },
      { key: "api", name: "Ana", role: "API design", provider: "codex", model: "gpt-5" },
    ],
    lead: { provider: "claude" },
  });
  const evt = session.events[0];
  if (evt?.type !== "experts.created") throw new Error("expected experts.created");
  return { model: session.model, projectId: project.project.id, sessionId: evt.session.id };
}

function started(): Panel {
  const panel = withSession();
  const { model } = run(panel.model, { type: "experts.start", sessionId: panel.sessionId });
  return { ...panel, model };
}

const sessionOf = (panel: Panel) => {
  const s = panel.model.expertsSessions[panel.sessionId];
  if (!s) throw new Error("session gone");
  return s;
};

describe("decide: experts.create", () => {
  it("accepts pi as an expert and as the lead (native Tide MCP since driver-pi 1.1)", () => {
    const created = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: "/repo" });
    const project = created.events[0];
    if (project?.type !== "project.created") throw new Error("expected project.created");
    const base = { type: "experts.create" as const, projectId: project.project.id, topic: "cache?" };

    // pi hosts the Tide MCP server natively since driver-pi 1.1 (R3), so it can sit on a panel and lead one
    expect(decide(created.model, { ...base, experts: [{ key: "perf", name: "Pat", role: "perf", provider: "pi" }], lead: { provider: "claude" } }, ctx).ok).toBe(true);
    expect(decide(created.model, { ...base, experts: [{ key: "perf", name: "Pat", role: "perf", provider: "claude" }], lead: { provider: "pi" } }, ctx).ok).toBe(true);
  });

  it("creates a setup-phase session with pending experts", () => {
    const panel = withSession();
    const session = sessionOf(panel);
    expect(session.phase).toBe("setup");
    expect(session.experts.map((e) => [e.key, e.status])).toEqual([
      ["perf", "pending"],
      ["api", "pending"],
    ]);
    expect(session.lead.provider).toBe("claude");
  });

  it("rejects duplicate and reserved expert keys", () => {
    const panel = withSession();
    const dup = decide(
      panel.model,
      {
        type: "experts.create",
        projectId: panel.projectId,
        topic: "t",
        experts: [
          { key: "a", name: "A", role: "r", provider: "claude" },
          { key: "a", name: "B", role: "r", provider: "claude" },
        ],
        lead: { provider: "claude" },
      },
      ctx,
    );
    expect(dup).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    const reserved = decide(
      panel.model,
      { type: "experts.create", projectId: panel.projectId, topic: "t", experts: [{ key: "lead", name: "A", role: "r", provider: "claude" }], lead: { provider: "claude" } },
      ctx,
    );
    expect(reserved).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });

  it("rejects an unknown project", () => {
    expect(
      decide(emptyReadModel(), { type: "experts.create", projectId: "nope", topic: "t", experts: [{ key: "a", name: "A", role: "r", provider: "claude" }], lead: { provider: "claude" } }, ctx),
    ).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("decide: experts.start", () => {
  it("spawns every thread, binds them and queues exploration in one decision", () => {
    const panel = withSession();
    const result = decide(panel.model, { type: "experts.start", sessionId: panel.sessionId }, ctx);
    if (!result.ok) throw new Error("expected ok");
    const types = result.events.map((e) => e.type);
    expect(types).toEqual([
      "thread.created",
      "thread.created",
      "thread.created",
      "experts.threads-bound",
      "experts.phase-changed",
      "turn.requested",
      "experts.expert-status-changed",
      "turn.requested",
      "experts.expert-status-changed",
    ]);
    const threads = result.events.flatMap((e) => (e.type === "thread.created" ? [e.thread] : []));
    expect(threads.map((t) => t.title)).toEqual(["Pat (performance)", "Ana (API design)", "Lead — How should we cache?"]);
    expect(threads.map((t) => t.role)).toEqual(["expert", "expert", "lead"]);
    // read-mostly panel: no approval prompt may stall the exploration
    expect(threads.every((t) => t.mode === "auto" && t.interaction === "default")).toBe(true);
    expect(threads[1]?.provider).toBe("codex");
    expect(threads[1]?.model).toBe("gpt-5");
    expect(threads.every((t) => t.expertsSessionId === panel.sessionId)).toBe(true);
  });

  it("moves to exploring with every expert working and a prompt naming its colleagues", () => {
    const panel = started();
    const session = sessionOf(panel);
    expect(session.phase).toBe("exploring");
    expect(session.experts.every((e) => e.status === "working")).toBe(true);
    expect(session.lead.threadId).toBeDefined();
    const perfThread = session.experts[0]?.threadId as string;
    const text = (panel.model.threadMessages[perfThread] ?? []).map((id) => panel.model.messages[id]?.text).join("");
    expect(text).toContain("You are Pat, performance");
    expect(text).toContain("Ana (API design)");
    expect(text).toContain("tide_experts_post_finding");
  });

  it("refuses to start twice", () => {
    const panel = started();
    expect(decide(panel.model, { type: "experts.start", sessionId: panel.sessionId }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });
});

describe("decide: experts phases", () => {
  it("goes exploring -> discussing with a discussion turn per idle expert", () => {
    const panel = started();
    // settle both exploration turns so the experts are idle again
    let model = panel.model;
    for (const expert of sessionOf(panel).experts) {
      const thread = model.threads[expert.threadId as string];
      model = run(model, { type: "turn.settle", turnId: thread?.latestTurnId as string, status: "completed" }).model;
    }
    model = run(model, { type: "experts.finding.post", sessionId: panel.sessionId, author: "perf", text: "hot loop in src/a.ts" }).model;
    const result = decide(model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "discussing" }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.events.filter((e) => e.type === "turn.requested")).toHaveLength(2);
    const prompt = result.events.flatMap((e) => (e.type === "turn.requested" ? [e.userMessage.text] : []))[0] ?? "";
    expect(prompt).toContain("hot loop in src/a.ts");
    expect(prompt).toContain("Challenge, agree, refine");
  });

  it("skips experts whose thread is still running", () => {
    const panel = started(); // both experts are mid-turn
    const result = decide(panel.model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "discussing" }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.events.filter((e) => e.type === "turn.requested")).toHaveLength(0);
  });

  it("rejects illegal transitions and archives from anywhere", () => {
    const panel = started();
    expect(decide(panel.model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "synthesizing" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(decide(panel.model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "setup" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const archived = run(panel.model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "archived" }).model;
    expect(archived.expertsSessions[panel.sessionId]?.phase).toBe("archived");
  });

  it("prompts the lead to synthesize", () => {
    const panel = started();
    let model = run(panel.model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "discussing" }).model;
    model = run(model, { type: "experts.finding.post", sessionId: panel.sessionId, author: "api", text: "the API leaks" }).model;
    const result = decide(model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "synthesizing" }, ctx);
    if (!result.ok) throw new Error("expected ok");
    const turns = result.events.flatMap((e) => (e.type === "turn.requested" ? [e] : []));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.turn.threadId).toBe(sessionOf(panel).lead.threadId);
    expect(turns[0]?.userMessage.text).toContain("tide_experts_synthesize");
    expect(turns[0]?.userMessage.text).toContain("the API leaks");
  });
});

describe("decide: agent commands", () => {
  it("records a finding from a panel member and refuses an outsider", () => {
    const panel = started();
    const posted = run(panel.model, { type: "experts.finding.post", sessionId: panel.sessionId, author: "perf", text: "n+1 query" });
    const finding = posted.events[0];
    if (finding?.type !== "experts.finding-posted") throw new Error("expected finding");
    expect(sessionOf({ ...panel, model: posted.model }).findingIds).toEqual([finding.finding.id]);
    expect(
      decide(panel.model, { type: "experts.finding.post", sessionId: panel.sessionId, author: "stranger", text: "x" }, ctx),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuses a message to an unknown recipient", () => {
    const panel = started();
    expect(
      decide(panel.model, { type: "experts.message.send", sessionId: panel.sessionId, from: "perf", to: "ghost", text: "hi" }, ctx),
    ).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("turns a synthesis into a proposed plan on the lead thread", () => {
    const panel = started();
    let model = run(panel.model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "discussing" }).model;
    model = run(model, { type: "experts.set-phase", sessionId: panel.sessionId, phase: "synthesizing" }).model;
    const result = run(model, { type: "experts.synthesis.set", sessionId: panel.sessionId, markdown: "# Decision\ncache it" });
    const session = result.model.expertsSessions[panel.sessionId];
    expect(session?.phase).toBe("ready");
    expect(session?.synthesis?.markdown).toContain("cache it");
    const planId = session?.synthesis?.planId as string;
    expect(result.model.plans[planId]).toMatchObject({ status: "proposed", threadId: session?.lead.threadId });
  });

  it("delegates to a child thread with a seeded turn", () => {
    const panel = started();
    const from = sessionOf(panel).experts[0]?.threadId as string;
    const result = run(panel.model, { type: "thread.delegate", fromThreadId: from, provider: "opencode", prompt: "measure the loop" });
    const created = result.events[0];
    if (created?.type !== "thread.created") throw new Error("expected thread.created");
    expect(created.thread).toMatchObject({ role: "delegate", delegatedBy: from, parentThreadId: from, provider: "opencode", mode: "auto" });
    const turn = result.events[1];
    if (turn?.type !== "turn.requested") throw new Error("expected turn.requested");
    expect(turn.userMessage.text).toContain("measure the loop");
    expect(turn.userMessage.text).toContain("delegated");
  });
});
