import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { mcpServerName, OpencodeInstance, parseModelId } from "./instance.ts";
import { LOGIN_COMMAND, LOGIN_HINT } from "./status.ts";
import type { OpencodeConfig } from "./types.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

function harness(config: Partial<OpencodeConfig> = {}): { instance: OpencodeInstance; api: FakeOpencodeApi } {
  const api = new FakeOpencodeApi();
  // serverUrl keeps the instance from probing for a real binary; apiImpl replaces HTTP.
  const instance = new OpencodeInstance({ serverUrl: "http://127.0.0.1:4096", apiImpl: api, ...config }, env);
  return { instance, api };
}

const baseOptions: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] };

describe("OpencodeInstance", () => {
  it("splits provider/model ids, keeping slashes in the model part", () => {
    expect(parseModelId("opencode/big-pickle")).toEqual({ providerID: "opencode", modelID: "big-pickle" });
    expect(parseModelId("openrouter/anthropic/claude")).toEqual({ providerID: "openrouter", modelID: "anthropic/claude" });
    expect(parseModelId("nope")).toBeUndefined();
    expect(parseModelId("/leading")).toBeUndefined();
    expect(parseModelId("trailing/")).toBeUndefined();
  });

  it("reports models from the harness catalog and caches the status", async () => {
    const { instance } = harness();
    const status = await instance.status();
    expect(status.kind).toBe("opencode");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.version).toBe("1.1.36");
    expect(status.hint).toBeUndefined();
    expect(status.models).toEqual([
      { id: "opencode/big-pickle", label: "Big Pickle", family: "opencode", default: true },
      { id: "opencode/small", label: "Small", family: "opencode" },
    ]);
    expect(status.caps).toMatchObject({ planMode: true, subagents: true, mcp: true, resume: true, openInTerminal: true });
    expect(await instance.status()).toBe(status);
    await instance.dispose();
  });

  it("reports the login hint when no provider has credentials", async () => {
    const { instance, api } = harness();
    api.providerCatalog = { providers: [], default: {} };
    const status = await instance.status();
    expect(status.loggedIn).toBe(false);
    expect(status.hint).toBe("Run `opencode auth login` in a terminal");
    expect(status.models).toEqual([]);
    await instance.dispose();
  });

  it("turns off planMode and subagents when the agent catalog does not offer them", async () => {
    const { instance, api } = harness();
    api.agentList = [{ name: "build", mode: "primary" }];
    const status = await instance.status();
    expect(status.caps.planMode).toBe(false);
    expect(status.caps.subagents).toBe(false);
    await instance.dispose();
  });

  it("opens a build session with the mode's ruleset, the pinned model and the thread's MCP servers", async () => {
    const { instance, api } = harness();
    const session = await instance.openSession({
      ...baseOptions,
      model: "opencode/big-pickle",
      mcpServers: [{ name: "tide", command: "node", args: ["mcp.js"], env: { A: "1" } }],
    });
    expect(session.nativeSessionId).toBe("ses_fake");
    expect(api.created[0]).toMatchObject({ directory: "/repo", permission: [{ permission: "edit", pattern: "*", action: "ask" }, { permission: "bash", pattern: "*", action: "ask" }, { permission: "webfetch", pattern: "*", action: "ask" }] });
    expect(api.mcp).toEqual([{ name: "tide-t1", command: ["node", "mcp.js"] }]);

    const events = session.send({ text: "hi" })[Symbol.asyncIterator]();
    const first = await events.next();
    expect(first.value).toEqual({ type: "session", nativeSessionId: "ses_fake", model: "opencode/big-pickle" });
    expect(api.prompts[0]?.agent).toBe("build");
    await session.close();
    await instance.dispose();
  });

  it("offers the exact login command when opencode has no usable provider", async () => {
    const { instance, api } = harness();
    api.providerCatalog = { providers: [], default: {} };
    const status = await instance.status();
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.hint).toBe(LOGIN_HINT);
    // verified against `opencode auth --help` (opencode 1.1.36)
    expect(status.loginCommand).toBe(LOGIN_COMMAND);
    await instance.dispose();
  });

  it("scopes each thread's MCP registration to that thread and tears it down on close", async () => {
    const { instance, api } = harness();
    const servers = [{ name: "tide", command: "node", args: ["mcp.js"], env: { TIDE_AGENT_TOKEN: "t1-token" } }];
    // both threads share one cwd, so one shared "tide" name would leave a single live server
    // holding whichever agent token registered last
    const first = await instance.openSession({ ...baseOptions, threadId: "t1", mcpServers: servers });
    const second = await instance.openSession({ ...baseOptions, threadId: "t2", mcpServers: servers });
    expect(api.mcp.map((entry) => entry.name)).toEqual([mcpServerName("tide", "t1"), mcpServerName("tide", "t2")]);

    await first.close();
    expect(api.mcpDisconnected).toEqual([{ directory: "/repo", name: "tide-t1" }]);
    await second.close();
    expect(api.mcpDisconnected.map((entry) => entry.name)).toEqual(["tide-t1", "tide-t2"]);
    await instance.dispose();
  });

  it("uses the plan agent for plan threads and reuses a resumed session id", async () => {
    const { instance, api } = harness();
    const session = await instance.openSession({ ...baseOptions, interaction: "plan", resume: "ses_old" });
    expect(api.created).toHaveLength(0);
    expect(session.nativeSessionId).toBe("ses_old");
    session.send({ text: "plan" })[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.prompts[0]?.agent).toBe("plan");
    await session.close();
    await instance.dispose();
  });

  it("offers the terminal escape hatch", () => {
    const { instance } = harness();
    expect(instance.terminalCommand("ses_1", "/tmp/my repo")).toBe("cd '/tmp/my repo' && opencode --session ses_1");
  });
});
