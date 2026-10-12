import { describe, expect, it } from "vitest";
import { emptyReadModel, replay, type Command, type DomainEvent, type ReadModel } from "@tide/contracts";
import { MAX_LIVE_DELEGATES } from "./agent.ts";
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

function rootThread(): { model: ReadModel; threadId: string } {
  const project = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: "/repo" });
  const p = project.events[0];
  if (p?.type !== "project.created") throw new Error("expected project.created");
  const thread = run(project.model, { type: "thread.create", projectId: p.project.id, provider: "claude" });
  const t = thread.events[0];
  if (t?.type !== "thread.created") throw new Error("expected thread.created");
  return { model: thread.model, threadId: t.thread.id };
}

/** Delegates from `fromThreadId`; returns the child's id. */
function delegate(model: ReadModel, fromThreadId: string): { model: ReadModel; childId: string } {
  const result = run(model, { type: "thread.delegate", fromThreadId, provider: "codex", prompt: "do it" });
  const created = result.events.find((e) => e.type === "thread.created");
  if (created?.type !== "thread.created") throw new Error("expected thread.created");
  return { model: result.model, childId: created.thread.id };
}

/** Settles every unsettled turn of a thread so its delegate no longer counts as live. */
function settleAll(model: ReadModel, threadId: string): ReadModel {
  let next = model;
  for (const turn of Object.values(model.turns)) {
    if (turn.threadId !== threadId || turn.settledAt !== undefined) continue;
    next = run(next, { type: "turn.settle", turnId: turn.id, status: "completed" }).model;
  }
  return next;
}

describe("decide: thread.delegate limits", () => {
  it("allows two levels of delegation and refuses the third", () => {
    const root = rootThread();
    const first = delegate(root.model, root.threadId);
    const second = delegate(first.model, first.childId);
    const third = decide(second.model, { type: "thread.delegate", fromThreadId: second.childId, provider: "claude", prompt: "deeper" }, ctx);
    expect(third).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("depth") } });
  });

  it(`caps a thread at ${MAX_LIVE_DELEGATES} running delegates; a settled one frees a slot`, () => {
    const root = rootThread();
    let model = root.model;
    const children: string[] = [];
    for (let i = 0; i < MAX_LIVE_DELEGATES; i++) {
      const next = delegate(model, root.threadId);
      model = next.model;
      children.push(next.childId);
    }
    const refused = decide(model, { type: "thread.delegate", fromThreadId: root.threadId, provider: "codex", prompt: "one more" }, ctx);
    expect(refused).toMatchObject({ ok: false, error: { code: "busy" } });

    model = settleAll(model, children[0] as string);
    expect(decide(model, { type: "thread.delegate", fromThreadId: root.threadId, provider: "codex", prompt: "one more" }, ctx).ok).toBe(true);
  });

  it("refuses delegation from an archived thread", () => {
    const root = rootThread();
    const archived = run(root.model, { type: "thread.archive", threadId: root.threadId }).model;
    expect(decide(archived, { type: "thread.delegate", fromThreadId: root.threadId, provider: "codex", prompt: "x" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });
});

describe("decide: experts.synthesis.set phase gate", () => {
  function panel(): { model: ReadModel; sessionId: string } {
    const project = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: "/repo" });
    const p = project.events[0];
    if (p?.type !== "project.created") throw new Error("expected project.created");
    const created = run(project.model, {
      type: "experts.create",
      projectId: p.project.id,
      topic: "cache?",
      experts: [{ key: "perf", name: "Pat", role: "performance", provider: "claude" }],
      lead: { provider: "claude" },
    });
    const evt = created.events[0];
    if (evt?.type !== "experts.created") throw new Error("expected experts.created");
    return { model: run(created.model, { type: "experts.start", sessionId: evt.session.id }).model, sessionId: evt.session.id };
  }

  const synth = (sessionId: string): Command => ({ type: "experts.synthesis.set", sessionId, markdown: "# plan" });

  it("refuses a synthesis while the panel is still exploring", () => {
    const { model, sessionId } = panel();
    expect(model.expertsSessions[sessionId]?.phase).toBe("exploring");
    expect(decide(model, synth(sessionId), ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("accepts one while synthesizing, and refuses another once the session is ready", () => {
    const { model, sessionId } = panel();
    const discussing = run(model, { type: "experts.set-phase", sessionId, phase: "discussing" }).model;
    const synthesizing = run(discussing, { type: "experts.set-phase", sessionId, phase: "synthesizing" }).model;
    const done = run(synthesizing, synth(sessionId)).model;
    expect(done.expertsSessions[sessionId]?.phase).toBe("ready");
    expect(decide(done, synth(sessionId), ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
