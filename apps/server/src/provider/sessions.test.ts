import { describe, expect, it } from "vitest";
import { emptyReadModel, type Project, type ReadModel, type Thread, type Turn } from "@tide/contracts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
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
}

function setup(): Setup {
  const clock = { t: 0 };
  const state = { model: emptyReadModel() };
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  const claude = createFakeDriver("claude");
  const codex = createFakeDriver("codex");
  registry.register(claude.driver);
  registry.register(codex.driver);
  const sessions = new SessionDirectory({ registry, now: () => clock.t, idleMs: 30 * 60_000, autoReap: false, log: () => undefined, model: () => state.model });
  return { sessions, claude: claude.control, codex: codex.control, clock, state };
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
