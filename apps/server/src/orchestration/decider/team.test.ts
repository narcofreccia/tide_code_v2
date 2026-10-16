import { describe, expect, it } from "vitest";
import { emptyReadModel, type Team } from "@tide/contracts";
import { teamBrief } from "../../experts/prompts.ts";
import { PRESET_TEAMS } from "../../teams/presets.ts";
import { stageSources } from "../../teams/stages.ts";
import { decide } from "./index.ts";
import { ctx, eventOf, run, tryRun, withThread } from "./r4.fixtures.ts";
import { teamRunTitle } from "./team.ts";
import { inheritedFrom } from "./vcs.ts";

const team: Team = {
  id: "t1",
  name: "Plan → Build → Review",
  stages: [
    { key: "lead", role: "planner", provider: "claude", worktree: "own", instructions: "Keep the plan short." },
    { key: "build", role: "implementer", provider: "codex", model: "gpt-5-codex", mode: "auto", worktree: "own" },
    { key: "review", role: "reviewer", provider: "opencode", worktree: "inherit", inheritFrom: "build", instructions: "Check the tests." },
  ],
};

function project(): { model: ReturnType<typeof emptyReadModel>; projectId: string } {
  const p = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: `/team-${ctx.now}` });
  return { model: p.model, projectId: eventOf(p.events, "project.created").project.id };
}

describe("decide: team.run", () => {
  it("creates the lead thread with the team and seeds it with the brief", () => {
    const p = project();
    const r = run(p.model, { type: "team.run", projectId: p.projectId, team, task: "Add rate limiting to the API\nwith tests" });
    expect(r.events.map((e) => e.type)).toEqual(["thread.created", "turn.requested"]);
    const created = eventOf(r.events, "thread.created");
    expect(created.useWorktree).toBe(true);
    expect(created.thread).toMatchObject({
      projectId: p.projectId,
      title: "Plan → Build → Review: Add rate limiting to the API",
      provider: "claude",
      mode: "approval-required",
      interaction: "default",
      team: { name: team.name, stages: team.stages },
    });
    expect(created.thread.role).toBeUndefined();
    const brief = eventOf(r.events, "turn.requested").userMessage.text;
    expect(brief).toBe(teamBrief(team, "Add rate limiting to the API\nwith tests", created.thread.id));
  });

  it("takes title, useWorktree and the lead's provider defaults from the command and settings", () => {
    const p = project();
    const result = decide(
      p.model,
      { type: "team.run", projectId: p.projectId, team, task: "x", title: "Mine", useWorktree: false },
      { ...ctx, worktreeByDefault: true, providerDefaults: { claude: { model: "opus", mode: "auto" } } },
    );
    if (!result.ok) throw new Error(result.error.message);
    const created = eventOf(result.events, "thread.created");
    expect(created.useWorktree).toBe(false);
    expect(created.thread).toMatchObject({ title: "Mine", model: "opus", mode: "auto" });
    const byDefault = decide(p.model, { type: "team.run", projectId: p.projectId, team, task: "x" }, { ...ctx, worktreeByDefault: false });
    expect(byDefault.ok && eventOf(byDefault.events, "thread.created").useWorktree).toBe(false);
  });

  it("refuses an unknown or archived project and an invalid inherit", () => {
    const p = project();
    expect(tryRun(p.model, { type: "team.run", projectId: "nope", team, task: "x" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const archived = run(p.model, { type: "project.archive", projectId: p.projectId }).model;
    expect(tryRun(archived, { type: "team.run", projectId: p.projectId, team, task: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const leadInherits: Team = { ...team, stages: [{ ...team.stages[0]!, worktree: "inherit" }] };
    expect(tryRun(p.model, { type: "team.run", projectId: p.projectId, team: leadInherits, task: "x" })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    const later: Team = { ...team, stages: [team.stages[0]!, { ...team.stages[2]!, inheritFrom: "build" }, team.stages[1]!] };
    expect(tryRun(p.model, { type: "team.run", projectId: p.projectId, team: later, task: "x" })).toMatchObject({ ok: false, error: { code: "invalid-command", message: expect.stringContaining("not an earlier stage") } });
  });

  it("titles from the first non-empty line, cut at 50 characters", () => {
    expect(teamRunTitle("T", "\n  short  \nmore")).toBe("T: short");
    const long = teamRunTitle("T", "a".repeat(80));
    expect(long.length).toBe("T: ".length + 50);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("teamBrief / stageSources", () => {
  it("resolves inherit sources (default: previous stage)", () => {
    expect(stageSources(team)).toEqual({ sources: [undefined, undefined, 1] });
    const implicit: Team = { ...team, stages: [team.stages[0]!, team.stages[1]!, { ...team.stages[2]!, inheritFrom: undefined }] } as Team;
    expect(stageSources(implicit)).toEqual({ sources: [undefined, undefined, 1] });
    expect(stageSources({ stages: [team.stages[0]!, { ...team.stages[1]!, key: "lead" }] })).toMatchObject({ error: expect.stringContaining("used twice") });
  });

  it("names every stage's harness and role with the exact tide_delegate call", () => {
    const brief = teamBrief(team, "Do it", "lead-id");
    expect(brief).toContain("You are stage 1 (\"lead\"), the planner, on claude");
    expect(brief).toContain("Instructions for you: Keep the plan short.");
    expect(brief).toContain(
      `tide_delegate {"provider":"codex","role":"implementer","model":"gpt-5-codex","mode":"auto","title":"Plan → Build → Review: implementer","useWorktree":true,"completion":"wait","timeoutMs":600000,`,
    );
    expect(brief).toContain(`"provider":"opencode","role":"reviewer"`);
    expect(brief).toContain(`"inheritWorktreeFrom":"<threadId of stage \\"build\\">"`);
    expect(brief).toContain("tide_thread_diff");
    expect(brief).toContain("Instructions for this stage (put them in its prompt): Check the tests.");
    expect(brief).toContain("keep calling `tide_thread_wait`");
    expect(brief).toContain("never skip a review or test stage");
    expect(brief).toContain("lists each stage");
  });

  it("hands a stage that inherits the lead's checkout the lead's own thread id", () => {
    const buildTest = PRESET_TEAMS[1]!;
    expect(teamBrief(buildTest, "x", "lead-42")).toContain(`"inheritWorktreeFrom":"lead-42"`);
  });

  it("every preset is valid", () => {
    for (const preset of PRESET_TEAMS) expect(stageSources(preset)).toHaveProperty("sources");
  });
});

/** A caller thread plus a source thread with a worktree in the same project. */
function withSource(): { model: ReturnType<typeof emptyReadModel>; callerId: string; sourceId: string } {
  const f = withThread("claude");
  const projectId = f.model.threads[f.threadId]!.projectId;
  const s = run(f.model, { type: "thread.create", projectId, provider: "codex", title: "Impl" });
  const sourceId = eventOf(s.events, "thread.created").thread.id;
  const model = run(s.model, { type: "worktree.attach", threadId: sourceId, worktreePath: "/wt/impl", branch: "tide/impl", baseBranch: "main" }).model;
  return { model, callerId: f.threadId, sourceId };
}

describe("decide: thread.delegate inheritWorktreeFrom", () => {
  it("attaches the source's checkout to the child in the same command, with no worktree request", () => {
    const f = withSource();
    const r = run(f.model, { type: "thread.delegate", fromThreadId: f.callerId, provider: "opencode", role: "reviewer", prompt: "review", inheritWorktreeFrom: f.sourceId });
    expect(r.events.map((e) => e.type)).toEqual(["thread.created", "worktree.attached", "turn.requested"]);
    const created = eventOf(r.events, "thread.created");
    expect(created.useWorktree).toBeUndefined();
    expect(eventOf(r.events, "worktree.attached")).toMatchObject({ threadId: created.thread.id, worktreePath: "/wt/impl", branch: "tide/impl", baseBranch: "main" });
    expect(r.model.threads[created.thread.id]).toMatchObject({ worktreePath: "/wt/impl", branch: "tide/impl", delegateRole: "reviewer" });
    expect(inheritedFrom(r.model, r.model.threads[created.thread.id]!)?.id).toBe(f.sourceId);
    expect(inheritedFrom(r.model, r.model.threads[f.sourceId]!)).toBeUndefined();
  });

  it("refuses a missing, foreign, archived or worktree-less source and mixed options", () => {
    const f = withSource();
    const base = { type: "thread.delegate" as const, fromThreadId: f.callerId, provider: "codex" as const, prompt: "x" };
    expect(tryRun(f.model, { ...base, inheritWorktreeFrom: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(tryRun(f.model, { ...base, inheritWorktreeFrom: f.sourceId, useWorktree: true })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    expect(tryRun(f.model, { ...base, inheritWorktreeFrom: f.sourceId, repo: "lib" })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    expect(tryRun(f.model, { ...base, inheritWorktreeFrom: f.callerId })).toMatchObject({ ok: false, error: { code: "invalid-command", message: expect.stringContaining("no worktree") } });
    const other = withThread("claude", true);
    const foreign = { ...f.model, threads: { ...f.model.threads, [other.threadId]: other.model.threads[other.threadId]! } };
    expect(tryRun(foreign, { ...base, inheritWorktreeFrom: other.threadId })).toMatchObject({ ok: false, error: { code: "invalid-command", message: expect.stringContaining("another project") } });
    const archived = run(f.model, { type: "thread.archive", threadId: f.sourceId }).model;
    expect(tryRun(archived, { ...base, inheritWorktreeFrom: f.sourceId })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });

  it("refuses merge and publish from the inheriting child, not from the source", () => {
    const f = withSource();
    const r = run(f.model, { type: "thread.delegate", fromThreadId: f.callerId, provider: "opencode", prompt: "review", inheritWorktreeFrom: f.sourceId });
    const childId = eventOf(r.events, "thread.created").thread.id;
    let model = run(r.model, { type: "turn.settle", turnId: eventOf(r.events, "turn.requested").turn.id, status: "completed" }).model;
    for (const command of [{ type: "thread.merge" as const, threadId: childId }, { type: "thread.publish" as const, threadId: childId }]) {
      expect(tryRun(model, command)).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining(`merge from "Impl"`) } });
    }
    expect(tryRun(model, { type: "thread.merge", threadId: f.sourceId })).toMatchObject({ ok: true });
    // once the source is archived, the checkout is the child's
    model = run(model, { type: "thread.archive", threadId: f.sourceId }).model;
    expect(tryRun(model, { type: "thread.merge", threadId: childId })).toMatchObject({ ok: true });
  });
});
