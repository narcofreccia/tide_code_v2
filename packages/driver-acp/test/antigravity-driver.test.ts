import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { ANTIGRAVITY_FLAVOR, ANTIGRAVITY_INSTALL_COMMAND, ANTIGRAVITY_PROFILE, antigravityDriver, completeAntigravity, createAcpInstance, createAntigravityInstance, inferModelFamily } from "../src/index.ts";
import type { ChildLike } from "../src/types.ts";
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
    expect(status.caps).toMatchObject({ resume: true, images: true, openInTerminal: false, subagents: true, steer: true, harnessTurns: true, fork: false, rollback: false, oneShot: true });
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

describe("Antigravity & ACP optimizations", () => {
  it("reports resume: true when sessionCapabilities.resume is advertised without loadSession", async () => {
    const child = new FakeChild();
    child.onClient = (message) => {
      const id = message.id ?? null;
      if (message.method === "initialize") child.send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      if (message.method === "session/new") child.send({ id, result: { sessionId: "s1" } });
    };
    const status = await createAntigravityInstance({}, env(), { spawn: spawnSeq(child) }).status();
    expect(status.caps.resume).toBe(true);
    expect(status.caps.oneShot).toBe(true);
  });

  it("status(true) re-probes session/new to refresh models and auth state", async () => {
    const first = new FakeChild();
    first.onClient = (m) => {
      if (m.method === "initialize") first.send({ id: m.id ?? null, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      if (m.method === "session/new") first.send({ id: m.id ?? null, result: { sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-2.5-pro", options: [{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }] }] } });
    };
    const second = new FakeChild();
    second.onClient = (m) => {
      if (m.method === "initialize") second.send({ id: m.id ?? null, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      if (m.method === "session/new") second.send({ id: m.id ?? null, result: { sessionId: "s2", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] }] } });
    };
    const instance = createAntigravityInstance({}, env(), { spawn: spawnSeq(first, second) });
    const s1 = await instance.status();
    expect(s1.models.map((m) => [m.id, m.family])).toEqual([["gemini-2.5-pro", "gemini-2.5"]]);
    const s2 = await instance.status(true);
    expect(s2.models.map((m) => [m.id, m.family])).toEqual([["gemini-4-neon", "gemini-4"]]);
  });

  it("folds thoughtTokens into outputTokens and sends session/close when advertised", async () => {
    const child = new FakeChild();
    child.onClient = (m) => {
      const id = m.id ?? null;
      if (m.method === "initialize") child.send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      if (m.method === "session/new") child.send({ id, result: { sessionId: "agy_close" } });
      if (m.method === "session/prompt") child.send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 40, thoughtTokens: 60, cachedReadTokens: 20 } } });
      if (m.method === "session/close") child.send({ id, result: {} });
    };
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-agy-usage-")));
    const instance = createAntigravityInstance({}, env(), { spawn: spawnSeq(child) });
    const session = await instance.openSession({ threadId: "t1", cwd, mode: "auto", interaction: "default", mcpServers: [] });
    const events = await collect(session.send({ text: "hi" }));
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 20 },
    });
    await session.close();
    expect(child.received.some((m) => m.method === "session/close" && (m.params as { sessionId?: string })?.sessionId === "agy_close")).toBe(true);
  });

  it("infers model families from group names and model id prefixes", () => {
    expect(inferModelFamily("gemini-2.5-pro")).toBe("gemini-2.5");
    expect(inferModelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(inferModelFamily("custom-x", "Google")).toBe("Google");
  });

  it("completeAntigravity runs agy --print --output-format json and parses result, label and usage", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let written = "";
    const stdin = {
      write(chunk: string | Buffer) {
        written += String(chunk);
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) written += String(chunk);
      },
    };
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      pid: 4242,
      killed: false,
      kill() {
        proc.killed = true;
        return true;
      },
    });
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = (command: string, args: readonly string[]): ChildLike => {
      calls.push({ command, args });
      return proc as unknown as ChildLike;
    };
    const pending = completeAntigravity(
      { command: "agy", args: ["acp"] },
      env(),
      { system: "Classify.", prompt: "hello", model: "gemini-2.5-flash", labels: ["yes", "no"], maxOutputTokens: 32, timeoutMs: 5_000, cwd: tmpdir() },
      { spawn },
    );
    stdout.end(JSON.stringify({ result: '{"label":"yes"}', model: "gemini-2.5-flash", usage: { inputTokens: 12, outputTokens: 3, thoughtTokens: 5 } }) + "\n");
    stderr.end();
    proc.emit("exit", 0, null);
    const result = await pending;
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--print", "--output-format", "json", "--disable-slash-commands", "--effort", "low", "--model", "gemini-2.5-flash", "--json-schema"]));
    expect(written).toContain("Classify.");
    expect(written).toContain("hello");
    expect(result).toMatchObject({ text: "yes", label: "yes", model: "gemini-2.5-flash", usage: { inputTokens: 12, outputTokens: 8 } });
  });

  it("steers a running Antigravity turn via mid-turn session/prompt and rejects when idle", async () => {
    const child = new FakeChild();
    const promptIds: Array<number | string | null> = [];
    child.onClient = (message) => {
      const id = message.id ?? null;
      if (message.method === "initialize") {
        child.send({ id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      }
      if (message.method === "session/new") child.send({ id, result: { sessionId: "agy_steer" } });
      if (message.method === "session/prompt") {
        promptIds.push(id);
        // The second prompt (steer) answers immediately; the first stays open until we settle it.
        if (promptIds.length === 2) {
          child.send({ id, result: { stopReason: "end_turn" } });
          child.send({ method: "session/update", params: { sessionId: "agy_steer", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "steered!" } } } });
          child.send({ id: promptIds[0]!, result: { stopReason: "end_turn" } });
        }
      }
    };
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-agy-steer-")));
    const instance = createAntigravityInstance({}, env(), { spawn: spawnSeq(child) });
    const session = await instance.openSession({ threadId: "t1", cwd, mode: "auto", interaction: "default", mcpServers: [] });
    await expect(session.steer!({ text: "too early" })).rejects.toThrow(/no turn is running/);

    const turnPromise = collect(session.send({ text: "start long task" }));
    await new Promise((r) => setTimeout(r, 5));
    await session.steer!({ text: "also check tests" });
    const events = await turnPromise;
    expect(events.some((e) => e.type === "assistant.delta" && e.delta === "steered!")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });

  it("normalizes invoke_subagent and /swarm tool calls into kind: child rows and tracks active swarm workers", async () => {
    const child = new FakeChild();
    child.onClient = (message) => {
      const id = message.id ?? null;
      if (message.method === "initialize") {
        child.send({ id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      }
      if (message.method === "session/new") child.send({ id, result: { sessionId: "agy_swarm" } });
      if (message.method === "session/prompt") {
        const sendUpdate = (update: Record<string, unknown>) =>
          child.send({ method: "session/update", params: { sessionId: "agy_swarm", update } });
        // 1. Built-in subagent
        sendUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "sub_1",
          name: "invoke_subagent",
          status: "in_progress",
          rawInput: { TypeName: "research", Role: "Codebase Researcher", Model: "flash", Workspace: "inherit", Prompt: "Audit drivers" },
        });
        sendUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "sub_1",
          status: "completed",
          rawOutput: { conversationId: "conv_abc12345", summary: "Found 3 drivers" },
        });
        // 2. Swarm title + sharded add + kill
        sendUpdate({ sessionUpdate: "tool_call", toolCallId: "sw_title", name: "swarm", status: "completed", rawInput: { action: "title", title: "Menu Graphics" } });
        sendUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "sw_add",
          name: "swarm",
          status: "completed",
          rawInput: { action: "add", name: "worker", model: "gemini-4-neon", workspace: "share", tasks: ["Build backend", "Build UI"] },
        });
        child.send({ id, result: { stopReason: "end_turn" } });
      }
    };
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-agy-swarm-")));
    const instance = createAntigravityInstance({}, env(), { spawn: spawnSeq(child) });
    const session = await instance.openSession({ threadId: "t1", cwd, mode: "auto", interaction: "default", mcpServers: [] });
    const events = await collect(session.send({ text: "/swarm Build menu graphics" }));
    const childActs = events.flatMap((e) => (e.type === "activity" && e.activity.kind === "child" ? [e.activity] : []));
    expect(childActs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ childKey: "sub_1", name: "Codebase Researcher", description: "research · flash", status: "running" }),
        expect.objectContaining({ childKey: "sub_1", name: "Codebase Researcher", taskId: "conv_abc12345", status: "done" }),
        expect.objectContaining({ childKey: "swarm:worker-1", name: "worker-1", description: "swarm · gemini-4-neon · share", status: "running", summary: "Build backend" }),
        expect.objectContaining({ childKey: "swarm:worker-2", name: "worker-2", description: "swarm · gemini-4-neon · share", status: "running", summary: "Build UI" }),
      ]),
    );
    expect(infos(events)).toContain("Swarm: Menu Graphics");
    expect(session.hasBackgroundWork!()).toBe(true);
    await session.close();
  });

  it("routes unsolicited post-turn updates via onIdleActivity without spawning fake turns, and opens a request-only harness turn for background approvals", async () => {
    const child = new FakeChild();
    child.onClient = (message) => {
      const id = message.id ?? null;
      if (message.method === "initialize") {
        child.send({ id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } });
      }
      if (message.method === "session/new") child.send({ id, result: { sessionId: "agy_bg" } });
      if (message.method === "session/prompt") child.send({ id, result: { stopReason: "end_turn" } });
    };
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-agy-bg-")));
    const instance = createAntigravityInstance({}, env(), { spawn: spawnSeq(child) });
    const session = await instance.openSession({ threadId: "t1", cwd, mode: "approval-required", interaction: "default", mcpServers: [] });
    const harnessTurns: Array<{ reason: string; events: Promise<NormalizedEvent[]> }> = [];
    const idleEvents: NormalizedEvent[] = [];
    session.onHarnessTurn!((handle) => {
      harnessTurns.push({ reason: handle.reason, events: collect(handle.events) });
    });
    session.onIdleActivity!((event) => {
      idleEvents.push(event);
    });
    await collect(session.send({ text: "launch background work" }));

    // Unsolicited post-turn chunks go to onIdleActivity (never opening synthetic harness turns)
    child.send({ method: "session/update", params: { sessionId: "agy_bg", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Worker finished!" } } } });
    await new Promise((r) => setTimeout(r, 5));
    expect(harnessTurns).toHaveLength(0);
    expect(idleEvents.some((e) => e.type === "assistant.delta" && e.delta === "Worker finished!")).toBe(true);

    // An unsolicited post-turn permission request opens a request-only harness turn and settles as soon as answered
    child.send({
      id: "perm-bg",
      method: "session/request_permission",
      params: {
        sessionId: "agy_bg",
        toolCall: { toolCallId: "tc-bg", title: "Run tests", kind: "execute" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(harnessTurns).toHaveLength(1);
    expect(session.hasBackgroundWork!()).toBe(true);
    await session.respondApproval("tc-bg", "accept");
    const bgEvents = await harnessTurns[0]!.events;
    expect(bgEvents.some((e) => e.type === "activity" && e.activity.kind === "approval" && e.activity.requestId === "tc-bg")).toBe(true);
    expect(bgEvents.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });
});
