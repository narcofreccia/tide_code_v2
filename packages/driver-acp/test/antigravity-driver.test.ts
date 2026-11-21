import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { ANTIGRAVITY_FLAVOR, ANTIGRAVITY_INSTALL_COMMAND, ANTIGRAVITY_PROFILE, antigravityDriver, createAcpInstance, createAntigravityInstance } from "../src/index.ts";
import { FakeChild, FixtureAgent, loadFixture, spawnSeq, type FixtureLine } from "./fake-agent.ts";

function env(extra: Partial<DriverEnv> = {}): DriverEnv {
  return { dataDir: mkdtempSync(join(tmpdir(), "tide-agy-driver-")), log: () => undefined, ...extra };
}

function enoent(): FakeChild {
  const child = new FakeChild();
  child.onClient = () => child.fail(Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));
  return child;
}

/** An agent that answers `initialize` with `version` and opens sessions without models. */
function agentAt(version: string): FakeChild {
  const child = new FakeChild();
  child.onClient = (message) => {
    const id = message.id ?? null;
    if (message.method === "initialize") child.send({ id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Antigravity ACP Server", version } } });
    if (message.method === "session/new") child.send({ id, result: { sessionId: "s" } });
  };
  return child;
}

async function collect(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const infos = (events: NormalizedEvent[]): string[] => events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" ? [event.activity.text] : []));

describe("Antigravity status (recorded, agy 1.5.14 signed out)", () => {
  it("reports its own kind, the version, the login command and the agent's first auth method as hint", async () => {
    const agent = new FixtureAgent(loadFixture("antigravity-1.5/signed-out"));
    const spawn = spawnSeq(agent.child);
    const e = env();
    const status = await createAntigravityInstance(antigravityDriver.defaultConfig(), e, { spawn }).status();
    expect(status).toMatchObject({ kind: "antigravity", installed: true, loggedIn: false, version: "1.5.14", loginCommand: "agy acp --login", hint: "Antigravity needs a login: Log in with your Google account" });
    expect(status.caps).toMatchObject({ resume: true, images: true, openInTerminal: false, subagents: false, steer: false, fork: false, rollback: false, oneShot: false });
    expect(spawn.calls[0]).toMatchObject({ command: "agy", args: ["acp"], cwd: join(e.dataDir, "acp-probe") });
    expect(agent.mismatches).toEqual([]);
  });

  it("not installed: the hint carries the install command", async () => {
    const status = await createAntigravityInstance({}, env(), { spawn: spawnSeq(enoent()) }).status();
    expect(status).toMatchObject({ kind: "antigravity", installed: false, loggedIn: false });
    expect(status.hint).toContain(`\`${ANTIGRAVITY_INSTALL_COMMAND}\``);
    expect(status).not.toHaveProperty("loginCommand");
  });

  it("below 1.5: installed but not usable, with the update hint, and no probe session", async () => {
    const child = agentAt("1.4.9");
    const status = await createAntigravityInstance({}, env(), { spawn: spawnSeq(child) }).status();
    expect(status).toMatchObject({ kind: "antigravity", installed: true, loggedIn: false, version: "1.4.9" });
    expect(status.hint).toContain("agy update");
    expect(child.received.map((message) => message.method)).toEqual(["initialize"]);
  });

  it("1.5.0 and later pass the floor", async () => {
    const status = await createAntigravityInstance({}, env(), { spawn: spawnSeq(agentAt("1.5.0")) }).status();
    expect(status).toMatchObject({ kind: "antigravity", installed: true, loggedIn: true, version: "1.5.0" });
  });
});

describe("generic ACP status keeps kind acp and no login command", () => {
  const noLogin = (status: object): void => expect(status).not.toHaveProperty("loginCommand");

  it("success, signed out, never answered and not installed", async () => {
    const ok = await createAcpInstance({ command: "fake" }, env(), { spawn: spawnSeq(new FixtureAgent(loadFixture("synthetic/init-config")).child) }).status();
    expect(ok).toMatchObject({ kind: "acp", loggedIn: true });
    noLogin(ok);

    const signedOut = await createAcpInstance({ command: "agy" }, env(), { spawn: spawnSeq(new FixtureAgent(loadFixture("antigravity-1.5/signed-out")).child) }).status();
    expect(signedOut).toMatchObject({ kind: "acp", installed: true, loggedIn: false, version: "1.5.14" });
    noLogin(signedOut);

    let fire: (() => void) | undefined;
    const timers = { setTimeout: (fn: () => void) => ((fire = fn), 1), clearTimeout: () => undefined };
    const pending = createAcpInstance({ command: "slow" }, env(), { spawn: spawnSeq(new FakeChild()), timers }).status();
    fire?.();
    const silent = await pending;
    expect(silent).toMatchObject({ kind: "acp", installed: true, loggedIn: false });
    noLogin(silent);

    const missing = await createAcpInstance({ command: "gemini" }, env(), { spawn: spawnSeq(enoent()) }).status();
    expect(missing).toMatchObject({ kind: "acp", installed: false });
    expect(missing.hint).toContain("pick another agent from the registry");
    noLogin(missing);
  });

  it("a generic agent is not held to Antigravity's version floor", async () => {
    const status = await createAcpInstance({ command: "fake" }, env(), { spawn: spawnSeq(agentAt("1.4.9")) }).status();
    expect(status).toMatchObject({ kind: "acp", loggedIn: true });
  });

  it("the flavor's terminal command drives openInTerminal and terminalCommand()", async () => {
    const flavor = { ...ANTIGRAVITY_FLAVOR, terminalCommand: (command: string, id: string) => `${command} --conversation ${id}` };
    const instance = createAcpInstance({ command: "agy" }, env(), { spawn: spawnSeq(agentAt("1.5.14")) }, flavor);
    expect((await instance.status()).caps.openInTerminal).toBe(true);
    expect(instance.terminalCommand("abc", "/repo")).toBe("agy --conversation abc");
  });
});

describe("antigravityDriver", () => {
  it("defaultConfig states the profile's launch and quirks", () => {
    expect(antigravityDriver.kind).toBe("antigravity");
    expect(antigravityDriver.defaultConfig()).toEqual({ command: "agy", args: ["acp"], quirks: ANTIGRAVITY_PROFILE.quirks });
  });

  it("a binaryPath not named agy launches that binary and keeps the quirks (no fs.writeTextFile)", async () => {
    const agent = new FixtureAgent(loadFixture("antigravity-1.5/signed-out"));
    const spawn = spawnSeq(agent.child);
    const config = { ...antigravityDriver.defaultConfig(), binaryPath: "/opt/google/antigravity-cli" };
    const instance = createAntigravityInstance(config, env({ instance: { id: "antigravity", label: "Antigravity", env: {} } }), { spawn });
    expect(instance.kind).toBe("antigravity");
    expect(instance.terminalCommand("x", "/repo")).toBeUndefined();
    await instance.status();
    expect(spawn.calls[0]).toMatchObject({ command: "/opt/google/antigravity-cli", args: ["acp"] });
    expect(agent.child.received[0]?.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } } });
  });

  it("create() goes through the real spawn and reports the install hint when the binary is missing", async () => {
    const instance = await antigravityDriver.create({ binaryPath: join(tmpdir(), "tide-no-such-agy") }, env());
    const status = await instance.status();
    expect(status).toMatchObject({ kind: "antigravity", installed: false });
    expect(status.hint).toContain(ANTIGRAVITY_INSTALL_COMMAND);
    await instance.dispose();
  });
});

describe("a model the agent could not select is visible", () => {
  async function turn(lines: FixtureLine[], model: string): Promise<{ events: NormalizedEvent[]; logs: string[] }> {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-acp-model-")));
    const logs: string[] = [];
    const agent = new FixtureAgent(lines);
    const instance = createAcpInstance({ command: "fake-agent", label: "Fake" }, { dataDir: cwd, log: (m) => logs.push(m) }, { spawn: agent.spawn });
    const session = await instance.openSession({ threadId: "t1", cwd, mode: "approval-required", interaction: "default", mcpServers: [], model });
    return { events: await collect(session.send({ text: "Reply with exactly: pong" })), logs };
  }

  it("the agent refuses the model: an info row names the model that runs, and the log keeps the reason", async () => {
    const refusal: FixtureLine[] = [
      { _dir: "c2a", jsonrpc: "2.0", id: 9, method: "session/set_config_option", params: {} },
      { jsonrpc: "2.0", id: 9, error: { code: -32602, message: "unknown model" } },
    ];
    const lines = [...loadFixture("synthetic/init-config"), ...refusal, ...loadFixture("synthetic/simple-turn")];
    const { events, logs } = await turn(lines, "ultra");
    expect(infos(events)).toEqual(["model ultra is not available on Fake; running on pro"]);
    expect(logs.some((line) => line.includes("set model ultra failed: unknown model"))).toBe(true);
  });

  it("the agent has no model selector: the row says it runs on its default", async () => {
    const lines = [...loadFixture("synthetic/init-bare"), ...loadFixture("synthetic/simple-turn")];
    const { events } = await turn(lines, "pro");
    expect(infos(events)).toEqual(["model pro is not available on Fake; running on its default model"]);
  });

  it("a model the agent accepts adds no row", async () => {
    const lines = [...loadFixture("synthetic/init-config"), ...loadFixture("synthetic/simple-turn")];
    const { events } = await turn(lines, "flash");
    expect(infos(events)).toEqual([]);
  });
});
