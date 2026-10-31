import { describe, expect, it } from "vitest";
import { emptyReadModel, type Project, type ReadModel, type Thread, type Turn } from "@tide/contracts";
import { createInstanceFactory } from "./instances.ts";
import { DriverRegistry } from "./registry.ts";
import { THREAD_TOOLS_HINT } from "@tide/tide-mcp";
import { resumableSessionId, SessionDirectory } from "./sessions.ts";
import { createFakeDriver, type FakeDriverControl } from "./testing/fakeDriver.ts";

const project: Project = { id: "p1", title: "T", rootPath: "/repo", createdAt: 0, updatedAt: 0 };
const thread = (patch: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p1",
  title: "Thread",
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

interface Setup {
  sessions: SessionDirectory;
  claude: FakeDriverControl;
  codex: FakeDriverControl;
  clock: { t: number };
  /** the read model the directory consults; tests mutate it in place */
  state: { model: ReadModel };
  registry: DriverRegistry;
}

function setup(): Setup {
  const clock = { t: 0 };
  const state = { model: emptyReadModel() };
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  const claude = createFakeDriver("claude");
  const codex = createFakeDriver("codex");
  registry.register(claude.driver);
  registry.register(codex.driver);
  registry.setFactory(createInstanceFactory({ providers: {}, acp: { find: () => undefined }, drivers: { claude: claude.driver } }));
  const sessions = new SessionDirectory({ registry, now: () => clock.t, idleMs: 30 * 60_000, autoReap: false, log: () => undefined, model: () => state.model });
  return { sessions, claude: claude.control, codex: codex.control, clock, state, registry };
}

/** A model where thread t1 has run one turn on `provider` and is in `status`. */
function modelWith(t: Thread, turn: Partial<Turn> = {}): ReadModel {
  const base: Turn = { id: "turn-1", threadId: t.id, status: "completed", provider: "claude", requestedAt: 0, startedAt: 1, ...turn };
  return { ...emptyReadModel(), threads: { [t.id]: { ...t, latestTurnId: base.id } }, turns: { [base.id]: base } };
}

describe("SessionDirectory", () => {
  it("opens once per thread and reuses the session", async () => {
    const { sessions, claude } = setup();
    const a = await sessions.getOrOpen(thread(), project);
    const b = await sessions.getOrOpen(thread(), project);
    expect(a).toBe(b);
    expect(claude.opened).toHaveLength(1);
    expect(claude.opened[0]).toMatchObject({ threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default" });
    expect(claude.opened[0]?.resume).toBeUndefined();
  });

  it("prefers the worktree path as cwd and resumes a known native session", async () => {
    const { sessions, claude } = setup();
    await sessions.getOrOpen(thread({ worktreePath: "/repo/.worktrees/t1", nativeSessionId: "sess-9", model: "opus" }), project);
    expect(claude.opened[0]).toMatchObject({ cwd: "/repo/.worktrees/t1", resume: "sess-9", model: "opus" });
  });

  it("closes the old session and opens fresh when the provider changes", async () => {
    const { sessions, claude, codex, state } = setup();
    state.model = modelWith(thread({ nativeSessionId: "sess-9" }));
    await sessions.getOrOpen(thread({ nativeSessionId: "sess-9" }), project);
    await sessions.getOrOpen(thread({ nativeSessionId: "sess-9", provider: "codex" }), project);
    expect(claude.closed).toEqual(["t1"]);
    expect(codex.opened).toHaveLength(1);
    expect(codex.opened[0]?.resume).toBeUndefined();
    expect(sessions.size).toBe(1);
  });

  it("applies changed mode/model in place when the driver can", async () => {
    const { sessions, claude } = setup();
    claude.reconfigureResult = "applied";
    const a = await sessions.getOrOpen(thread(), project);
    const b = await sessions.getOrOpen(thread({ mode: "auto", model: "opus" }), project);
    expect(b).toBe(a);
    expect(claude.reconfigures).toEqual([{ threadId: "t1", settings: { mode: "auto", interaction: "default", model: "opus" } }]);
    // same settings again: no second reconfigure call
    await sessions.getOrOpen(thread({ mode: "auto", model: "opus" }), project);
    expect(claude.reconfigures).toHaveLength(1);
    expect(claude.opened).toHaveLength(1);
  });

  it("R8: opens with the thread's effort and reconfigures when it changes", async () => {
    const { sessions, claude } = setup();
    claude.reconfigureResult = "applied";
    await sessions.getOrOpen(thread({ effort: "low" }), project);
    expect(claude.opened[0]?.effort).toBe("low");
    await sessions.getOrOpen(thread({ effort: "high" }), project);
    expect(claude.reconfigures).toEqual([{ threadId: "t1", settings: { mode: "approval-required", interaction: "default", effort: "high" } }]);
  });

  it("R8: a different instance of the same kind gets its own session", async () => {
    const { sessions, claude, registry } = setup();
    await registry.syncInstances([{ id: "claude:work", kind: "claude", label: "Work" }]);
    await sessions.getOrOpen(thread(), project);
    await sessions.getOrOpen(thread({ providerId: "claude:work" }), project);
    expect(claude.closed).toEqual(["t1"]);
    expect(claude.opened).toHaveLength(2);
    expect(claude.created.map((c) => c.env.instance?.id)).toEqual(["claude", "claude:work"]);
    const work = claude.created[1]?.instance;
    expect(work && sessions.usesInstance(work)).toBe(true);
  });

  it("reopens with resume when the driver cannot switch live", async () => {
    const { sessions, claude } = setup();
    await sessions.getOrOpen(thread({ nativeSessionId: "sess-9" }), project);
    const b = await sessions.getOrOpen(thread({ nativeSessionId: "sess-9", interaction: "plan" }), project);
    expect(claude.closed).toEqual(["t1"]);
    expect(claude.opened).toHaveLength(2);
    expect(claude.opened[1]).toMatchObject({ resume: "sess-9", interaction: "plan" });
    expect(b).toBe(claude.sessions[1]);
    expect(sessions.size).toBe(1);
  });

  it("reaps sessions untouched for the idle window", async () => {
    const { sessions, claude, clock } = setup();
    await sessions.getOrOpen(thread(), project);
    clock.t = 29 * 60_000;
    expect(await sessions.reapIdle()).toEqual([]);
    sessions.touch("t1");
    clock.t = 58 * 60_000;
    expect(await sessions.reapIdle()).toEqual([]);
    clock.t = 60 * 60_000;
    expect(await sessions.reapIdle()).toEqual(["t1"]);
    expect(claude.closed).toEqual(["t1"]);
    expect(sessions.size).toBe(0);
    expect(sessions.peek("t1")).toBeUndefined();
  });

  it("never resumes a session id minted by another harness, even on a fresh directory", async () => {
    const { sessions, codex, claude, state } = setup();
    // the log says claude minted sess-9; the thread now runs on codex (e.g. a pre-clear log)
    const switched = thread({ nativeSessionId: "sess-9", provider: "codex" });
    state.model = modelWith(switched, { provider: "claude" });
    await sessions.getOrOpen(switched, project);
    expect(codex.opened[0]?.resume).toBeUndefined();
    // and the owning harness still resumes it
    await sessions.close("t1");
    const back = thread({ nativeSessionId: "sess-9" });
    state.model = modelWith(back, { provider: "claude" });
    await sessions.getOrOpen(back, project);
    expect(claude.opened[0]?.resume).toBe("sess-9");
  });

  it("never reaps a session whose thread has a turn in flight", async () => {
    const { sessions, claude, clock, state } = setup();
    const t = thread({ status: "running" });
    state.model = modelWith(t, { status: "running" });
    await sessions.getOrOpen(t, project);
    clock.t = 120 * 60_000;
    expect(await sessions.reapIdle()).toEqual([]);
    expect(claude.closed).toEqual([]);
    // once the turn settles, the idle rule applies again
    state.model = modelWith({ ...t, status: "idle" }, { status: "completed" });
    expect(await sessions.reapIdle()).toEqual(["t1"]);
  });

  it("R14: never reaps a session whose harness still runs background work", async () => {
    const { sessions, claude, clock } = setup();
    await sessions.getOrOpen(thread(), project);
    const session = claude.sessionFor("t1")!;
    session.backgroundWork = true;
    clock.t = 120 * 60_000;
    expect(await sessions.reapIdle()).toEqual([]);
    expect(claude.closed).toEqual([]);
    // the sub-agents reported: the idle rule applies again
    session.backgroundWork = false;
    expect(await sessions.reapIdle()).toEqual(["t1"]);
  });

  it("R14: forwards turns the harness starts by itself, from the moment the session opens", async () => {
    const clock = { t: 0 };
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
    const claude = createFakeDriver("claude");
    registry.register(claude.driver);
    const seen: { threadId: string; reason: string }[] = [];
    const sessions = new SessionDirectory({
      registry,
      now: () => clock.t,
      autoReap: false,
      log: () => undefined,
      model: () => emptyReadModel(),
      onHarnessTurn: (threadId, turn) => void seen.push({ threadId, reason: turn.reason }),
    });
    await sessions.getOrOpen(thread(), project);
    clock.t = 5_000;
    claude.control.sessionFor("t1")!.emitHarnessTurn("sub-agent reported", [{ type: "settled", status: "completed" }]);
    expect(seen).toEqual([{ threadId: "t1", reason: "sub-agent reported" }]);
    // a harness turn is a sign of life: the reaper counts from it
    clock.t = 5_000 + 30 * 60_000 - 1;
    expect(await sessions.reapIdle()).toEqual([]);
  });

  it("close() and closeAll() release live sessions", async () => {
    const { sessions, claude } = setup();
    await sessions.getOrOpen(thread(), project);
    await sessions.getOrOpen(thread({ id: "t2" }), project);
    await sessions.close("t1");
    expect(sessions.size).toBe(1);
    await sessions.closeAll();
    expect(sessions.size).toBe(0);
    expect(claude.closed).toEqual(["t1", "t2"]);
  });
});

describe("SessionDirectory: R4", () => {
  it("tells every session that carries Tide's MCP server about the thread tools", async () => {
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
    const claude = createFakeDriver("claude");
    registry.register(claude.driver);
    const sessions = new SessionDirectory({ registry, autoReap: false, mcp: { serversFor: () => [], revoke: () => undefined } });
    await sessions.getOrOpen(thread(), project);
    expect(claude.control.opened[0]?.systemPromptAppend).toContain(THREAD_TOOLS_HINT);
  });

  it("resumes the current harness's own session after a switch back, even though another harness ran last", async () => {
    const t = thread({ nativeSessionId: "claude-1", providerSessions: { claude: { nativeSessionId: "claude-1" }, codex: { nativeSessionId: "codex-1" } } });
    const model = modelWith(t, { provider: "codex" });
    expect(resumableSessionId(t, model)).toBe("claude-1");
    // a stale id the current harness never minted is still refused
    expect(resumableSessionId({ ...t, nativeSessionId: "codex-1" }, model)).toBeUndefined();
  });

  it("opens a fork instead of resuming when asked", async () => {
    const { sessions, claude } = setup();
    await sessions.getOrOpen(thread({ nativeSessionId: "x" }), project, { forkFrom: "src-1" });
    expect(claude.opened[0]).toMatchObject({ forkFrom: "src-1" });
    expect(claude.opened[0]?.resume).toBeUndefined();
  });
});
