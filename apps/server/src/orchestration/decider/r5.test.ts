import { describe, expect, it } from "vitest";
import { emptyReadModel, type Command, type DomainEvent, type ReadModel } from "@tide/contracts";
import { delegatePrompt } from "../../experts/prompts.ts";
import { titleFromPrompt } from "./autoTitle.ts";
import { decide } from "./index.ts";
import { apply, completeTurn, ctx, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";
import type { DecideDefaults } from "./types.ts";

/** Runs a command with user-settings defaults in the context. */
function runWith(model: ReadModel, command: Command, defaults: DecideDefaults): { model: ReadModel; events: DomainEvent[] } {
  ctx.now += 10;
  const result = decide(model, command, { ...ctx, ...defaults });
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.code} ${result.error.message}`);
  return { model: apply(model, result.events), events: result.events };
}

function untitled(): { model: ReadModel; threadId: string; projectId: string } {
  const project = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: `/r5-${ctx.now}` });
  const projectId = eventOf(project.events, "project.created").project.id;
  const t = run(project.model, { type: "thread.create", projectId, provider: "claude" });
  return { model: t.model, threadId: eventOf(t.events, "thread.created").thread.id, projectId };
}

describe("decide: thread.unarchive / project.unarchive", () => {
  it("brings an archived thread back, idempotently", () => {
    const f = withThread();
    const archived = run(f.model, { type: "thread.archive", threadId: f.threadId }).model;
    const back = run(archived, { type: "thread.unarchive", threadId: f.threadId });
    expect(back.events).toEqual([{ type: "thread.unarchived", threadId: f.threadId, at: ctx.now }]);
    expect(back.model.threads[f.threadId]?.archivedAt).toBeUndefined();
    expect(run(back.model, { type: "thread.unarchive", threadId: f.threadId }).events).toEqual([]);
    expect(decide(back.model, { type: "thread.unarchive", threadId: "nope" }, ctx)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("refuses a thread whose project is archived until the project is back", () => {
    const f = untitled();
    let model = run(f.model, { type: "thread.archive", threadId: f.threadId }).model;
    model = run(model, { type: "project.archive", projectId: f.projectId }).model;
    expect(decide(model, { type: "thread.unarchive", threadId: f.threadId }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const project = run(model, { type: "project.unarchive", projectId: f.projectId });
    expect(project.events).toEqual([{ type: "project.unarchived", projectId: f.projectId, at: ctx.now }]);
    expect(project.model.projects[f.projectId]?.archivedAt).toBeUndefined();
    expect(run(project.model, { type: "project.unarchive", projectId: f.projectId }).events).toEqual([]);
    expect(run(project.model, { type: "thread.unarchive", threadId: f.threadId }).model.threads[f.threadId]?.archivedAt).toBeUndefined();
  });

  it("refuses a project whose root another live project took meanwhile", () => {
    const first = run(emptyReadModel(), { type: "project.create", title: "A", rootPath: "/same" });
    const a = eventOf(first.events, "project.created").project.id;
    let model = run(first.model, { type: "project.archive", projectId: a }).model;
    model = run(model, { type: "project.create", title: "B", rootPath: "/same" }).model;
    expect(decide(model, { type: "project.unarchive", projectId: a }, ctx)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: thread.delete", () => {
  it("deletes an archived thread and the model forgets its turns and messages", () => {
    const f = withThread("claude", true);
    const projectId = f.model.threads[f.threadId]?.projectId;
    const { model, turnId } = completeTurn(f.model, f.threadId, "hi", "hello");
    const archived = run(model, { type: "thread.archive", threadId: f.threadId, keepWorktree: true }).model;
    const deleted = run(archived, { type: "thread.delete", threadId: f.threadId });
    expect(deleted.events).toEqual([
      { type: "thread.deleted", threadId: f.threadId, projectId, worktreePath: "/wt/thread", branch: "tide/login", at: ctx.now },
    ]);
    expect(deleted.model.threads[f.threadId]).toBeUndefined();
    expect(deleted.model.turns[turnId]).toBeUndefined();
    expect(Object.values(deleted.model.messages).filter((m) => m.threadId === f.threadId)).toEqual([]);
    expect(deleted.model.threadMessages[f.threadId]).toBeUndefined();
    expect(tryRun(deleted.model, { type: "thread.delete", threadId: f.threadId })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("deletes a live idle thread; the event carries no paths it does not have", () => {
    const f = withThread();
    const deleted = run(f.model, { type: "thread.delete", threadId: f.threadId });
    expect(deleted.events).toEqual([{ type: "thread.deleted", threadId: f.threadId, projectId: f.model.threads[f.threadId]?.projectId, at: ctx.now }]);
    expect(deleted.model.threads[f.threadId]).toBeUndefined();
  });

  it("refuses a running thread and an unknown one", () => {
    const f = withThread();
    const { model } = startTurn(f.model, f.threadId, "go");
    expect(tryRun(model, { type: "thread.delete", threadId: f.threadId })).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(tryRun(model, { type: "thread.delete", threadId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("refuses a thread with children, archived or not, until they are deleted", () => {
    const f = withThread();
    const d = run(f.model, { type: "thread.delegate", fromThreadId: f.threadId, provider: "codex", prompt: "go", useWorktree: false });
    const childId = eventOf(d.events, "thread.created").thread.id;
    let model = run(d.model, { type: "turn.settle", turnId: eventOf(d.events, "turn.requested").turn.id, status: "completed" }).model;
    model = run(model, { type: "thread.archive", threadId: childId }).model;
    expect(tryRun(model, { type: "thread.delete", threadId: f.threadId })).toMatchObject({ ok: false, error: { code: "conflict", message: `thread ${f.threadId} still has child threads; delete them first` } });
    model = run(model, { type: "thread.delete", threadId: childId }).model;
    expect(run(model, { type: "thread.delete", threadId: f.threadId }).model.threads[f.threadId]).toBeUndefined();

    const g = withThread();
    const projectId = g.model.threads[g.threadId]?.projectId ?? "";
    const fork = run(g.model, { type: "thread.create", projectId, provider: "claude", parentThreadId: g.threadId });
    expect(tryRun(fork.model, { type: "thread.delete", threadId: g.threadId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses a thread whose worktree another live thread shares", () => {
    const f = withThread("claude", true);
    const projectId = f.model.threads[f.threadId]?.projectId ?? "";
    const other = run(f.model, { type: "thread.create", projectId, provider: "codex" });
    const otherId = eventOf(other.events, "thread.created").thread.id;
    let model = run(other.model, { type: "worktree.attach", threadId: otherId, worktreePath: "/wt/thread", branch: "tide/login" }).model;
    expect(tryRun(model, { type: "thread.delete", threadId: f.threadId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    model = run(model, { type: "thread.archive", threadId: otherId, keepWorktree: true }).model;
    expect(tryRun(model, { type: "thread.delete", threadId: f.threadId })).toMatchObject({ ok: true });
  });

  it("refuses an Experts thread until its session is archived", () => {
    const f = withThread();
    const projectId = f.model.threads[f.threadId]?.projectId ?? "";
    const created = run(f.model, { type: "experts.create", projectId, topic: "t", experts: [{ key: "a", name: "A", role: "r", provider: "claude" }], lead: { provider: "claude" } });
    const sessionId = eventOf(created.events, "experts.created").session.id;
    const started = run(created.model, { type: "experts.start", sessionId });
    const expertId = started.events.flatMap((e) => (e.type === "thread.created" && e.thread.role === "expert" ? [e.thread.id] : []))[0] ?? "";
    let model = started.model;
    for (const t of Object.values(model.threads)) {
      if (t.status === "running" && t.latestTurnId !== undefined) model = run(model, { type: "turn.settle", turnId: t.latestTurnId, status: "completed" }).model;
    }
    expect(tryRun(model, { type: "thread.delete", threadId: expertId })).toMatchObject({ ok: false, error: { code: "conflict", message: "thread belongs to a live Experts session; archive the session first" } });
    model = run(model, { type: "experts.archive", sessionId }).model;
    expect(tryRun(model, { type: "thread.delete", threadId: expertId })).toMatchObject({ ok: true });
  });
});

describe("decide: thread.update pinned", () => {
  it("pins and unpins through the patch", () => {
    const f = withThread();
    const pinned = run(f.model, { type: "thread.update", threadId: f.threadId, pinned: true });
    expect(pinned.events[0]).toMatchObject({ type: "thread.updated", patch: { pinned: true } });
    expect(pinned.model.threads[f.threadId]?.pinned).toBe(true);
    expect(run(pinned.model, { type: "thread.update", threadId: f.threadId, pinned: false }).model.threads[f.threadId]?.pinned).toBe(false);
  });
});

describe("auto-title", () => {
  it("derives a title from the first line with text", () => {
    expect(titleFromPrompt("\n\n## Fix the   **login** `bug`\nmore")).toBe("Fix the login bug");
    expect(titleFromPrompt("```\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(titleFromPrompt("> - quoted bullet")).toBe("quoted bullet");
    expect(titleFromPrompt("   ")).toBeUndefined();
    const long = "Refactor the provider reactor so that every queued turn is promoted exactly once per settle";
    const title = titleFromPrompt(long) ?? "";
    expect(title).toBe("Refactor the provider reactor so that every queued turn is…");
    expect(title.length).toBeLessThanOrEqual(61);
    expect(titleFromPrompt("x".repeat(80))).toBe(`${"x".repeat(60)}…`);
  });

  it("names a default-titled thread before its first turn, in the same command", () => {
    const f = untitled();
    const { events, model } = run(f.model, { type: "turn.request", threadId: f.threadId, text: "# Add dark mode\n\ndetails" });
    expect(events.map((e) => e.type)).toEqual(["thread.updated", "turn.requested"]);
    expect(events[0]).toMatchObject({ patch: { title: "Add dark mode" }, autoTitled: true });
    expect(model.threads[f.threadId]?.title).toBe("Add dark mode");
  });

  it("never renames a titled thread, a queued follow-up or a notification turn", () => {
    const titled = withThread();
    expect(run(titled.model, { type: "turn.request", threadId: titled.threadId, text: "hello" }).events.map((e) => e.type)).toEqual(["turn.requested"]);

    const f = untitled();
    const notified = run(f.model, { type: "turn.request", threadId: f.threadId, text: "Delegate finished", notification: { source: "delegate", summary: "x" } });
    expect(notified.events.map((e) => e.type)).toEqual(["turn.requested"]);
    // the thread is running now: a follow-up queues and does not name it either
    const queued = run(notified.model, { type: "turn.request", threadId: f.threadId, text: "follow up" });
    expect(queued.events.map((e) => e.type)).toEqual(["turn.requested"]);
    expect(queued.model.threads[f.threadId]?.title).toBe("New thread");
  });

  it("keeps a delegate's and a plan's own title", () => {
    const f = withThread();
    const d = run(f.model, { type: "thread.delegate", fromThreadId: f.threadId, provider: "codex", prompt: "go" });
    expect(eventOf(d.events, "thread.created").thread.title).toBe("Delegated by Login fix");
    expect(d.events.filter((e) => e.type === "thread.updated")).toEqual([]);
  });
});

describe("settings defaults in the decider", () => {
  it("a freshly limited thread takes the limit policy from settings, a per-thread choice wins", () => {
    const f = withThread();
    const limited = runWith(f.model, { type: "thread.limited", threadId: f.threadId }, { limitPolicy: "reset" });
    expect(eventOf(limited.events, "thread.limited").limited.resume).toBe("reset");
    const manual = run(limited.model, { type: "thread.limit-policy", threadId: f.threadId, resume: "manual" }).model;
    expect(eventOf(runWith(manual, { type: "thread.limited", threadId: f.threadId }, { limitPolicy: "reset" }).events, "thread.limited").limited.resume).toBe("manual");
    const g = withThread();
    expect(eventOf(run(g.model, { type: "thread.limited", threadId: g.threadId }).events, "thread.limited").limited.resume).toBe("manual");
  });

  it("a delegate gets a worktree by default, honours worktreeByDefault=false and an explicit choice", () => {
    const f = withThread();
    const cmd: Command = { type: "thread.delegate", fromThreadId: f.threadId, provider: "codex", prompt: "go" };
    expect(eventOf(run(f.model, cmd).events, "thread.created").useWorktree).toBe(true);
    expect(eventOf(runWith(f.model, cmd, { worktreeByDefault: false }).events, "thread.created").useWorktree).toBe(false);
    expect(eventOf(runWith(f.model, { ...cmd, useWorktree: true }, { worktreeByDefault: false }).events, "thread.created").useWorktree).toBe(true);
  });

  it("a delegate takes the provider's default model and mode, clamped to the parent", () => {
    const f = withThread(); // approval-required parent
    const defaults: DecideDefaults = { providerDefaults: { codex: { model: "gpt-5", mode: "full-access" } } };
    const d = eventOf(runWith(f.model, { type: "thread.delegate", fromThreadId: f.threadId, provider: "codex", prompt: "go" }, defaults).events, "thread.created").thread;
    expect(d).toMatchObject({ model: "gpt-5", mode: "approval-required" });
    const explicit = eventOf(runWith(f.model, { type: "thread.delegate", fromThreadId: f.threadId, provider: "codex", prompt: "go", model: "o3" }, defaults).events, "thread.created").thread;
    expect(explicit.model).toBe("o3");
  });

  it("plan.implement and experts threads take the provider default model", () => {
    const f = withThread();
    const { model, turnId } = completeTurn(f.model, f.threadId, "plan it", "ok");
    const proposed = run(model, { type: "plan.propose", turnId, markdown: "# Ship it\n- a" });
    const planId = eventOf(proposed.events, "plan.proposed").plan.id;
    const defaults: DecideDefaults = { providerDefaults: { pi: { model: "pi-model", mode: "auto" }, claude: { model: "opus" } } };
    const impl = eventOf(runWith(proposed.model, { type: "plan.implement", planId, provider: "pi" }, defaults).events, "thread.created").thread;
    expect(impl).toMatchObject({ title: "Ship it", model: "pi-model", mode: "auto" });

    const projectId = f.model.threads[f.threadId]?.projectId ?? "";
    const created = run(proposed.model, { type: "experts.create", projectId, topic: "t", experts: [{ key: "a", name: "A", role: "r", provider: "claude" }], lead: { provider: "pi" } });
    const sessionId = eventOf(created.events, "experts.created").session.id;
    const threads = runWith(created.model, { type: "experts.start", sessionId }, defaults).events.flatMap((e) => (e.type === "thread.created" ? [e.thread] : []));
    expect(threads.map((t) => [t.role, t.model, t.mode])).toEqual([["expert", "opus", "auto"], ["lead", "pi-model", "auto"]]);
  });
});

describe("delegate role framing", () => {
  it("frames the prompt with the role when one is given", () => {
    expect(delegatePrompt("look", "Lead", "reviewer")).toContain('You act as the reviewer for thread "Lead"');
    expect(delegatePrompt("look", "Lead")).not.toContain("You act as");
    const f = withThread();
    const d = run(f.model, { type: "thread.delegate", fromThreadId: f.threadId, provider: "codex", prompt: "look", role: "tester" });
    expect(eventOf(d.events, "turn.requested").userMessage.text).toContain('You act as the tester for thread "Login fix"');
  });
});
