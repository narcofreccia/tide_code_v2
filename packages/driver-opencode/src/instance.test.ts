import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { chooseAgents, INSTRUCTION_KEY, mcpServerName, OpencodeInstance, parseModelId } from "./instance.ts";
import { LOGIN_COMMAND, LOGIN_HINT } from "./status.ts";
import type { OpencodeConfig } from "./types.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

function harness(config: Partial<OpencodeConfig> = {}, logs: string[] = []): { instance: OpencodeInstance; api: FakeOpencodeApi } {
  const api = new FakeOpencodeApi();
  // apiImpl replaces HTTP and skips binary probing; serverUrl keeps discovery out of it
  const instance = new OpencodeInstance({ serverUrl: "http://127.0.0.1:4096", apiImpl: api, ...config }, { ...env, log: (msg) => logs.push(msg) });
  return { instance, api };
}

const baseOptions: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] };

describe("OpencodeInstance", () => {
  it("splits provider/model ids into v2 model refs, keeping slashes in the model part", () => {
    expect(parseModelId("opencode/big-pickle")).toEqual({ providerID: "opencode", id: "big-pickle" });
    expect(parseModelId("openrouter/anthropic/claude")).toEqual({ providerID: "openrouter", id: "anthropic/claude" });
    expect(parseModelId("nope")).toBeUndefined();
    expect(parseModelId("trailing/")).toBeUndefined();
  });

  it("reports models from the server catalog (default marked, deprecated hidden) and caches the status", async () => {
    const { instance, api } = harness();
    api.modelList.push({ id: "old", providerID: "opencode", name: "Old", status: "deprecated" });
    const status = await instance.status();
    expect(status).toMatchObject({ kind: "opencode", installed: true, loggedIn: true });
    expect(status.hint).toBeUndefined();
    expect(status.models).toEqual([
      { id: "opencode/big-pickle", label: "Big Pickle", family: "opencode", default: true },
      { id: "opencode/small", label: "Small", family: "opencode" },
    ]);
    expect(status.caps).toMatchObject({ planMode: true, subagents: true, mcp: true, resume: true, openInTerminal: true });
    expect(await instance.status()).toBe(status);
    await instance.dispose();
  });

  it("offers the exact login command when nothing is connected", async () => {
    const { instance, api } = harness();
    api.modelList = [];
    const status = await instance.status();
    expect(status).toMatchObject({ installed: true, loggedIn: false, hint: LOGIN_HINT, loginCommand: LOGIN_COMMAND, models: [] });
    await instance.dispose();
  });

  it("turns off planMode and subagents when the agent catalog lacks them", async () => {
    const { instance, api } = harness();
    api.agentList = [{ id: "build", name: "Build", mode: "primary", hidden: false }];
    const status = await instance.status();
    expect(status.caps.planMode).toBe(false);
    expect(status.caps.subagents).toBe(false);
    await instance.dispose();
  });

  it("honours the user's default primary agent (listed first by the server) and skips hidden ones", () => {
    expect(chooseAgents([
      { id: "title", name: "t", mode: "primary", hidden: true },
      { id: "review", name: "r", mode: "primary", hidden: false },
      { id: "build", name: "b", mode: "primary", hidden: false },
      { id: "plan", name: "p", mode: "primary", hidden: false },
    ])).toEqual({ build: "review", plan: "plan" });
    expect(chooseAgents([])).toEqual({ build: "build" });
  });

  it("creates a session with agent, model, mode ruleset, Tide instructions and thread-scoped MCP", async () => {
    const { instance, api } = harness();
    const session = await instance.openSession({
      ...baseOptions,
      model: "opencode/big-pickle",
      systemPromptAppend: "be terse",
      mcpServers: [{ name: "tide", command: "node", args: ["mcp.js"], env: { A: "1" } }],
    });
    expect(session.nativeSessionId).toBe("ses_fake");
    expect(api.created[0]).toMatchObject({
      directory: "/repo",
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      metadata: { tideThreadId: "t1" },
      permissions: [
        { action: "edit", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "ask" },
        { action: "webfetch", resource: "*", effect: "ask" },
      ],
    });
    expect(api.instructions).toEqual([{ key: INSTRUCTION_KEY, value: "be terse" }]);
    expect(api.mcp).toEqual([{ directory: "/repo", name: "tide-t1", command: ["node", "mcp.js"] }]);
    await session.close();
    expect(api.mcpRemoved).toEqual([{ directory: "/repo", name: "tide-t1" }]);
    await instance.dispose();
  });

  it("gives each thread its own MCP registration name", async () => {
    const { instance, api } = harness();
    const servers = [{ name: "tide", command: "node" }];
    await instance.openSession({ ...baseOptions, threadId: "t1", mcpServers: servers });
    await instance.openSession({ ...baseOptions, threadId: "t2", mcpServers: servers });
    expect(api.mcp.map((entry) => entry.name)).toEqual([mcpServerName("tide", "t1"), mcpServerName("tide", "t2")]);
    await instance.dispose();
  });

  it("replays the user's config rules narrowed by the mode, with read-only link denies last", async () => {
    const { instance, api } = harness();
    api.configEntries = [{ type: "document", info: { permissions: [{ action: "shell", resource: "*", effect: "allow" }, { action: "shell", resource: "git *", effect: "allow" }] } }];
    await instance.openSession({ ...baseOptions, linkedDirs: [{ path: "/repos/infra", label: "infra", access: "read" }] });
    const kinds = (api.created[0]?.permissions ?? []).map((rule) => `${rule.action}:${rule.resource}:${rule.effect}`);
    expect(kinds.slice(0, 3)).toEqual(["edit:*:ask", "shell:*:ask", "webfetch:*:ask"]);
    // the user's blanket allow is kept, then narrowed to the mode's ask
    expect(kinds).toContain("shell:*:allow");
    expect(kinds.indexOf("shell:git *:ask")).toBeGreaterThan(kinds.indexOf("shell:git *:allow"));
    expect(kinds.at(-1)).toBe("edit:../repos/infra/*:deny");
    await instance.dispose();
  });

  it("opens anyway when the config cannot be read", async () => {
    const logs: string[] = [];
    const { instance, api } = harness({}, logs);
    api.configError = new Error("HTTP 404");
    await instance.openSession(baseOptions);
    expect(api.created[0]?.permissions).toHaveLength(3);
    expect(logs.some((line) => line.includes("could not read the user's config"))).toBe(true);
    await instance.dispose();
  });

  it("re-applies ruleset, agent and model to a resumed session in place, with its usage as baseline", async () => {
    const { instance, api } = harness();
    api.existing = { agent: "build", model: { providerID: "opencode", id: "small" }, cost: 1, tokens: { input: 500, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } };
    const session = await instance.openSession({ ...baseOptions, interaction: "plan", mode: "auto", model: "opencode/big-pickle", resume: "ses_old" });
    expect(api.created).toHaveLength(0);
    expect(session.nativeSessionId).toBe("ses_old");
    expect(api.agentSwitches).toEqual(["plan"]);
    expect(api.modelSwitches).toEqual([{ providerID: "opencode", id: "big-pickle" }]);
    expect(api.rulesets[0]?.sessionId).toBe("ses_old");
    if (!session.reconfigure) throw new Error("opencode sessions must implement reconfigure");
    await expect(session.reconfigure({ mode: "approval-required", interaction: "default" })).resolves.toBe("applied");
    expect(api.agentSwitches).toEqual(["plan", "build"]);
    await instance.dispose();
  });

  it("offers the terminal escape hatch, using a configured 2.x binary verbatim", () => {
    expect(harness().instance.terminalCommand("ses_1", "/tmp/my repo")).toBe("cd '/tmp/my repo' && opencode --session ses_1");
    expect(harness({ binaryPath: "/opt/oc 2/opencode" }).instance.terminalCommand("ses_1", "/r")).toBe("cd /r && '/opt/oc 2/opencode' --session ses_1");
  });
});
