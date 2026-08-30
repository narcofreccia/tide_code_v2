import { describe, expect, it } from "vitest";
import type { Project, Thread } from "@tide/contracts";
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

function setup(): { sessions: SessionDirectory; claude: FakeDriverControl; codex: FakeDriverControl; clock: { t: number } } {
  const clock = { t: 0 };
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  const claude = createFakeDriver("claude");
  const codex = createFakeDriver("codex");
  registry.register(claude.driver);
  registry.register(codex.driver);
  const sessions = new SessionDirectory({ registry, now: () => clock.t, idleMs: 30 * 60_000, autoReap: false, log: () => undefined });
  return { sessions, claude: claude.control, codex: codex.control, clock };
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
    const { sessions, claude, codex } = setup();
    await sessions.getOrOpen(thread({ nativeSessionId: "sess-9" }), project);
    await sessions.getOrOpen(thread({ nativeSessionId: "sess-9", provider: "codex" }), project);
    expect(claude.closed).toEqual(["t1"]);
    expect(codex.opened).toHaveLength(1);
    expect(codex.opened[0]?.resume).toBeUndefined();
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
