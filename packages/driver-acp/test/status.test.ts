import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { acpDriver, agentEnv, createAcpInstance } from "../src/index.ts";
import { FakeChild, FixtureAgent, loadFixture, spawnSeq } from "./fake-agent.ts";

function env(extra: Partial<DriverEnv> = {}): DriverEnv {
  return { dataDir: mkdtempSync(join(tmpdir(), "tide-acp-status-")), log: () => undefined, ...extra };
}

function enoent(): FakeChild {
  const child = new FakeChild();
  child.onClient = () => child.fail(Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" }));
  return child;
}

describe("status()", () => {
  it("ENOENT → installed false with an install hint", async () => {
    const instance = createAcpInstance({ command: "gemini", label: "Gemini CLI" }, env(), { spawn: spawnSeq(enoent()) });
    const status = await instance.status();
    expect(status).toMatchObject({ kind: "acp", installed: false, loggedIn: false, models: [] });
    expect(status.hint).toContain("Gemini CLI could not be started (`gemini` not found)");
    expect(status.hint).toContain("pick another agent from the registry");
  });

  it("OpenCode 1.1 (recorded): version from agentInfo, caps from capabilities, models + plan from the probe session", async () => {
    const agent = new FixtureAgent(loadFixture("opencode-acp-1.1/init"));
    const spawn = spawnSeq(agent.child);
    const e = env();
    const instance = createAcpInstance({ command: "opencode", args: ["acp"] }, e, { spawn });
    const status = await instance.status();
    expect(status).toMatchObject({ kind: "acp", installed: true, loggedIn: true, version: "1.1.36" });
    expect(status.caps).toEqual({
      planMode: true,
      subagents: false,
      mcp: true,
      images: true,
      resume: true,
      contextUsage: false,
      openInTerminal: false,
      steer: false,
      fork: false,
      rollback: false,
      oneShot: false,
      effort: false,
      commands: true,
    });
    expect(status.models.find((model) => model.default)?.id).toBe("opencode/big-pickle");
    // the probe never runs in a user repo, and the process is gone afterwards
    expect(spawn.calls[0]).toMatchObject({ command: "opencode", args: ["acp"], cwd: join(e.dataDir, "acp-probe") });
    expect(agent.child.signals).toEqual(["SIGTERM"]);
  });

  it("OpenCode 2.0 (recorded): configOptions give models with efforts, plan mode and effort caps", async () => {
    const status = await createAcpInstance({ command: "opencode", args: ["acp"] }, env(), { spawn: spawnSeq(new FixtureAgent(loadFixture("opencode-acp/init")).child) }).status();
    expect(status).toMatchObject({ installed: true, loggedIn: true, version: "2.0.29" });
    expect(status.caps).toMatchObject({ planMode: true, effort: true, images: true, resume: true });
    expect(status.models.find((model) => model.default)?.id).toBe("opencode/flint-40b-free");
    expect(status.models[0]?.efforts?.map((effort) => effort.id)).toEqual(["low", "medium", "high", "xhigh", "max", "default"]);
  });

  it("caches for 60 s and only probes models once per instance", async () => {
    const spawn = spawnSeq(new FixtureAgent(loadFixture("synthetic/init-config")).child);
    const instance = createAcpInstance({ command: "fake" }, env(), { spawn });
    const [a, b] = await Promise.all([instance.status(), instance.status()]);
    expect(a).toBe(b);
    expect(await instance.status()).toBe(a);
    expect(spawn.calls).toHaveLength(1);
    expect(a.caps.effort).toBe(true);
    expect(a.caps.images).toBe(false);
    expect(a.models.map((model) => model.id)).toEqual(["pro", "flash"]);
  });

  it("auth_required from the probe session → loggedIn false with the agent's own hint", async () => {
    const child = new FakeChild();
    child.onClient = (message) => {
      if (message.method === "initialize") child.send({ id: message.id ?? null, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "oauth", name: "Google", description: "Run `gemini` and sign in with Google" }] } });
      if (message.method === "session/new") child.send({ id: message.id ?? null, error: { code: -32000, message: "Authentication required" } });
    };
    const status = await createAcpInstance({ command: "gemini", label: "Gemini" }, env(), { spawn: spawnSeq(child) }).status();
    expect(status).toMatchObject({ installed: true, loggedIn: false, hint: "Gemini needs a login: Run `gemini` and sign in with Google" });
  });

  it("an agent that never answers initialize is reported, not hung on", async () => {
    let fire: (() => void) | undefined;
    const timers = { setTimeout: (fn: () => void) => ((fire = fn), 1), clearTimeout: () => undefined };
    const child = new FakeChild();
    const pending = createAcpInstance({ command: "slow" }, env(), { spawn: spawnSeq(child), timers }).status();
    fire?.();
    const status = await pending;
    expect(status).toMatchObject({ installed: true, loggedIn: false });
    expect(status.hint).toContain("did not answer initialize");
  });

  it("openSession on a logged-out agent throws the login hint and status() reports it", async () => {
    const loggedOut = (): FakeChild => {
      const child = new FakeChild();
      child.onClient = (message) => {
        const id = message.id ?? null;
        if (message.method === "initialize") child.send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "a", name: "a", description: "Run `fake login`" }] } });
        if (message.method === "session/new") child.send({ id, error: { code: -32000, message: "Authentication required" } });
      };
      return child;
    };
    const live = loggedOut();
    const spawn = spawnSeq(live, loggedOut());
    const instance = createAcpInstance({ command: "fake", label: "Fake" }, env(), { spawn });
    await expect(instance.openSession({ threadId: "t", cwd: tmpdir(), mode: "auto", interaction: "default", mcpServers: [] })).rejects.toThrow("Fake needs a login: Run `fake login`");
    expect(live.signals).toEqual(["SIGTERM"]);
    const status = await instance.status();
    expect(status).toMatchObject({ installed: true, loggedIn: false, hint: "Fake needs a login: Run `fake login`" });
    expect(spawn.calls).toHaveLength(2);
  });
});

describe("driver + environment", () => {
  it("acpDriver has the ProviderDriver shape and refuses an empty command", async () => {
    expect(acpDriver.kind).toBe("acp");
    expect(acpDriver.defaultConfig()).toEqual({ command: "" });
    await expect(acpDriver.create({ command: "" }, env())).rejects.toThrow(/no launch command/);
    const instance = await acpDriver.create({ command: "opencode", args: ["acp"] }, env());
    expect(instance.kind).toBe("acp");
    expect(instance.terminalCommand("x", "/tmp")).toBeUndefined();
    await instance.dispose();
  });

  it("env merges instance env, config env and session env; home moves HOME only when set", () => {
    const base = env({ instance: { id: "acp:gemini", label: "Gemini", env: { A: "instance", B: "instance" }, home: "/homes/work" } });
    const merged = agentEnv({ command: "x", env: { B: "config", C: "config" } }, base, { C: "session" });
    expect(merged).toMatchObject({ A: "instance", B: "config", C: "session", HOME: "/homes/work" });
    expect(agentEnv({ command: "x", home: "/override" }, base).HOME).toBe("/override");
    expect(agentEnv({ command: "x" }, env()).HOME).toBe(process.env["HOME"]);
  });
});
