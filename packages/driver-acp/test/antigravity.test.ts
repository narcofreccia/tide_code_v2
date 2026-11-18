import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, OpenSessionOptions, ProviderSession } from "@tide/contracts";
import { ANTIGRAVITY_PROFILE, clientInitialize, createAcpInstance, profileForCommand, systemPromptMeta, withProfileQuirks } from "../src/index.ts";
import type { AcpConfig, JsonRpcMessage } from "../src/types.ts";
import { FixtureAgent, loadFixture } from "./fake-agent.ts";

const TURN = "synthetic-antigravity/turn";
const RESUME = "synthetic-antigravity/resume";

async function open(fixture: string, config: AcpConfig, options: Partial<OpenSessionOptions> = {}): Promise<{ agent: FixtureAgent; session: ProviderSession }> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-agy-")));
  const agent = new FixtureAgent(loadFixture(fixture, cwd));
  const instance = createAcpInstance(config, { dataDir: cwd, log: () => undefined }, { spawn: agent.spawn });
  const session = await instance.openSession({ threadId: "t1", cwd, mode: "approval-required", interaction: "default", mcpServers: [], systemPromptAppend: "Be terse.", ...options });
  return { agent, session };
}

async function collect(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const sent = (agent: FixtureAgent, method: string): JsonRpcMessage[] => agent.child.received.filter((message) => message.method === method);
const AGY: AcpConfig = { command: ANTIGRAVITY_PROFILE.command, args: ANTIGRAVITY_PROFILE.args, quirks: ANTIGRAVITY_PROFILE.quirks };

describe("clientInitialize quirks", () => {
  it("without quirks it is exactly the generic handshake", () => {
    expect(clientInitialize("1.0.0")).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "tide", version: "1.0.0" } });
    expect(clientInitialize("1.0.0", {})).toEqual(clientInitialize("1.0.0"));
  });

  it("advertiseFsWrite: false drops writeTextFile; Tide still identifies itself as tide", () => {
    const init = clientInitialize("1.0.0", { advertiseFsWrite: false }) as { clientCapabilities: unknown; clientInfo: { name: string } };
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: false }, terminal: false });
    expect(init.clientInfo.name).toBe("tide");
  });

  it("builds the nested _meta only when there is a prompt and a path", () => {
    expect(systemPromptMeta(ANTIGRAVITY_PROFILE.quirks, "Be terse.")).toEqual({ antigravity: { systemPrompt: { append: "Be terse." } } });
    expect(systemPromptMeta(ANTIGRAVITY_PROFILE.quirks, "  ")).toBeUndefined();
    expect(systemPromptMeta(ANTIGRAVITY_PROFILE.quirks, undefined)).toBeUndefined();
    expect(systemPromptMeta(undefined, "x")).toBeUndefined();
  });
});

describe("Antigravity profile", () => {
  it("launches `agy acp` and attaches itself to that command only", () => {
    expect(ANTIGRAVITY_PROFILE).toMatchObject({ label: "Antigravity", command: "agy", args: ["acp"] });
    expect(profileForCommand("/usr/local/bin/agy")?.id).toBe("antigravity");
    expect(profileForCommand("agy.exe")?.id).toBe("antigravity");
    expect(profileForCommand("gemini")).toBeUndefined();
    expect(withProfileQuirks({ command: "agy" }).quirks).toBe(ANTIGRAVITY_PROFILE.quirks);
    expect(withProfileQuirks({ command: "gemini" })).toEqual({ command: "gemini" });
    expect(withProfileQuirks({ command: "agy", quirks: {} }).quirks).toEqual({});
  });

  it("a session: no fs write, system prompt in _meta (no <tide-context>), permission answered by Tide's mode, end_turn", async () => {
    const { agent, session } = await open(TURN, AGY, { mode: "auto-accept-edits" });
    expect(sent(agent, "initialize")[0]?.params).toMatchObject({ clientCapabilities: { fs: { writeTextFile: false } }, clientInfo: { name: "tide" } });
    expect(sent(agent, "session/new")[0]?.params).toMatchObject({ _meta: { antigravity: { systemPrompt: { append: "Be terse." } } } });
    const events = await collect(session.send({ text: "change hello to hi" }));
    // the edit permission was answered from the runtime mode: no approval card
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(sent(agent, "session/prompt")[0]?.params).toEqual({ sessionId: "agy_1", prompt: [{ type: "text", text: "change hello to hi" }] });
    expect(agent.mismatches).toEqual([]);
    expect(agent.extras).toEqual([]);
  });

  it("never switches the agent's mode for the runtime mode, on open or on reconfigure", async () => {
    const { agent, session } = await open(TURN, AGY, { mode: "full-access" });
    await session.reconfigure?.({ mode: "auto-accept-edits", interaction: "default" } as never);
    await session.reconfigure?.({ mode: "full-access", interaction: "default" } as never);
    expect(sent(agent, "session/set_mode")).toEqual([]);
    expect(sent(agent, "session/set_config_option")).toEqual([]);
  });

  it("still selects the agent's plan mode for plan interaction", async () => {
    const { agent } = await open(TURN, AGY, { mode: "full-access", interaction: "plan" });
    expect(sent(agent, "session/set_mode")[0]?.params).toEqual({ sessionId: "agy_1", modeId: "plan" });
  });

  it("model and thinking level come from the agent's config options", async () => {
    const { agent, session } = await open(TURN, AGY, { model: "agy-flash", effort: "high" });
    expect(sent(agent, "session/set_config_option").map((m) => m.params)).toEqual([
      { sessionId: "agy_1", configId: "model", value: "agy-flash" },
      { sessionId: "agy_1", configId: "thinking", value: "high" },
    ]);
    expect(session.nativeSessionId).toBe("agy_1");
  });

  it("resume uses session/resume with the system prompt, and mutes nothing it did not replay", async () => {
    const { agent, session } = await open(RESUME, AGY, { resume: "agy_old" });
    expect(sent(agent, "session/resume")[0]?.params).toMatchObject({ sessionId: "agy_old", _meta: { antigravity: { systemPrompt: { append: "Be terse." } } } });
    expect(sent(agent, "session/load")).toEqual([]);
    expect(session.nativeSessionId).toBe("agy_old");
    expect((session as { resumeFailed?: string }).resumeFailed).toBeUndefined();
  });

  it("an agent without the resume capability that offers loadSession is reopened with session/load", async () => {
    const { agent } = await open("synthetic/init-config", AGY, { resume: "agy_old" });
    expect(sent(agent, "session/resume")).toEqual([]);
    expect(sent(agent, "session/load")[0]?.params).toMatchObject({ sessionId: "agy_old" });
  });

  it("with no quirks the generic agent still gets writeTextFile, no _meta and a <tide-context> block", async () => {
    const { agent, session } = await open("synthetic/init-config", { command: "fake-agent" });
    expect(sent(agent, "initialize")[0]?.params).toMatchObject({ clientCapabilities: { fs: { writeTextFile: true } } });
    expect(sent(agent, "session/new")[0]?.params).not.toHaveProperty("_meta");
    void session;
  });
});
