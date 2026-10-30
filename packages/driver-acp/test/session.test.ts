import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, OpenSessionOptions, ProviderSession } from "@tide/contracts";
import { createAcpInstance } from "../src/index.ts";
import type { AcpConfig, JsonRpcMessage } from "../src/types.ts";
import { FixtureAgent, loadFixture } from "./fake-agent.ts";

interface Opened {
  agent: FixtureAgent;
  session: ProviderSession;
  cwd: string;
  logs: string[];
}

async function open(fixtures: string[], options: Partial<OpenSessionOptions> = {}, config: Partial<AcpConfig> = {}): Promise<Opened> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-acp-")));
  const agent = new FixtureAgent(fixtures.flatMap((name) => loadFixture(name, cwd)));
  const logs: string[] = [];
  const instance = createAcpInstance({ command: "fake-agent", ...config }, { dataDir: cwd, log: (m) => logs.push(m) }, { spawn: agent.spawn });
  const session = await instance.openSession({ threadId: "t1", cwd, mode: "approval-required", interaction: "default", mcpServers: [], ...options });
  return { agent, session, cwd, logs };
}

async function collect(stream: AsyncIterable<NormalizedEvent>, onEvent?: (event: NormalizedEvent) => void | Promise<void>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    await onEvent?.(event);
  }
  return events;
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

function sent(agent: FixtureAgent, method: string): JsonRpcMessage[] {
  return agent.child.received.filter((message) => message.method === method);
}

const CONFIG = "synthetic/init-config";

describe("AcpSession turns", () => {
  it("simple turn: session announced, streamed text, settled completed", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/simple-turn"]);
    expect(session.nativeSessionId).toBe("sess_1");
    const events = await collect(session.send({ text: "Reply with exactly: pong" }));
    expect(kinds(events)).toEqual(["session", "assistant.reasoning", "assistant.delta", "assistant.delta", "usage", "usage", "settled"]);
    // the cumulative usage_update cost becomes the turn's cost
    expect(events.at(-2)).toEqual({ type: "usage", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.001 } });
    expect(events[0]).toEqual({ type: "session", nativeSessionId: "sess_1", model: "pro" });
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(sent(agent, "session/prompt")[0]?.params).toEqual({ sessionId: "sess_1", prompt: [{ type: "text", text: "Reply with exactly: pong" }] });
    expect(sent(agent, "initialize")[0]?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "tide" } });
  });

  it("OpenCode 2.0 (recorded): pong turn with reasoning, context usage and per-turn token usage", async () => {
    const { session } = await open(["opencode-acp/init", "opencode-acp/simple-turn"]);
    const events = await collect(session.send({ text: "Reply with exactly: pong" }));
    expect(kinds(events)).toEqual(["session", "commands", "assistant.reasoning", "assistant.reasoning", "assistant.reasoning", "assistant.reasoning", "assistant.delta", "usage", "usage", "settled"]);
    expect(events[0]).toEqual({ type: "session", nativeSessionId: "ses_e738332efffeoMZmFqW90c4iK1", model: "opencode/flint-40b-free" });
    expect(events.find((event) => event.type === "assistant.delta")).toMatchObject({ delta: "pong" });
    expect(events.at(-3)).toEqual({ type: "usage", contextUsage: { used: 9960, window: 262144 } });
    expect(events.at(-2)).toEqual({ type: "usage", usage: { inputTokens: 77, outputTokens: 27, cacheReadTokens: 9856 } });
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("OpenCode 2.0 (recorded): read + edit tool calls without permission requests (OpenCode allows by default)", async () => {
    const { agent, session } = await open(["opencode-acp/tool-turn"]);
    const events = await collect(session.send({ text: "edit" }));
    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools.map((tool) => [tool.toolName, tool.status])).toEqual([
      ["read", "running"],
      ["read", "running"],
      ["read", "ok"],
      ["edit", "running"],
      ["edit", "running"],
      ["edit", "ok"],
    ]);
    expect(tools[4]?.input).toEqual({ newString: "hi from tide", oldString: "hello from tide", path: "hello.txt" });
    expect(tools[5]?.output).toContain("+hi from tide");
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(false);
    expect(agent.child.received.some((message) => message.method === undefined)).toBe(false); // no agent→client requests
    // text after the tools is its own message
    const keys = new Set(events.flatMap((event) => (event.type === "assistant.delta" ? [event.messageKey] : [])));
    expect(keys.size).toBe(1);
    expect([...keys][0]).not.toBe("acp-1#0");
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("OpenCode 2.0 (recorded): plan interaction selects mode=plan through configOptions", async () => {
    const { agent } = await open(["opencode-acp/init"], { interaction: "plan", model: "opencode/big-pickle", effort: "high" });
    expect(sent(agent, "session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: "ses_e738332efffeoMZmFqW90c4iK1", configId: "model", value: "opencode/big-pickle" },
      { sessionId: "ses_e738332efffeoMZmFqW90c4iK1", configId: "effort", value: "high" },
      { sessionId: "ses_e738332efffeoMZmFqW90c4iK1", configId: "mode", value: "plan" },
    ]);
  });

  it("approval is held until respondApproval, then answered with the allow_once option", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/tool-permission-accept"]);
    let replyBeforeAnswer: JsonRpcMessage | undefined;
    const events = await collect(session.send({ text: "change hello to hi" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "approval") {
        replyBeforeAnswer = agent.child.received.find((message) => message.id === "perm-1");
        await session.respondApproval(event.activity.requestId, "accept");
      }
    });
    expect(replyBeforeAnswer).toBeUndefined();
    expect(agent.mismatches).toEqual([]);
    const approval = events.find((event) => event.type === "activity" && event.activity.kind === "approval");
    expect(approval).toMatchObject({ activity: { requestId: "call_1", toolName: "Edit hello.txt", status: "pending", title: "Edit hello.txt", input: { path: "/repo/hello.txt" } } });
    if (approval?.type !== "activity" || approval.activity.kind !== "approval") throw new Error("unreachable");
    expect(approval.activity.diff).toContain("+hi");
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("decline answers with the reject_once option", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/permission-declined"]);
    const events = await collect(session.send({ text: "run rm -rf build" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "approval") await session.respondApproval(event.activity.requestId, "decline");
    });
    expect(agent.mismatches).toEqual([]);
    expect(agent.child.received.find((message) => message.id === "perm-2")?.result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("interrupt: session/cancel notification, pending permission answered cancelled, settled interrupted", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/cancel-mid-turn"]);
    const events = await collect(session.send({ text: "refactor everything" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "approval") await session.interrupt();
    });
    expect(agent.mismatches).toEqual([]);
    const order = agent.child.received.map((message) => message.method ?? `reply:${String(message.id)}`);
    expect(order.slice(-2)).toEqual(["session/cancel", "reply:perm-3"]);
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("OpenCode 1.1 (recorded) answers end_turn after a cancel: still settles interrupted", async () => {
    const { session } = await open(["opencode-acp-1.1/init", "opencode-acp-1.1/cancel-turn"]);
    const events = await collect(session.send({ text: "Reply with exactly: pong" }), async (event) => {
      if (event.type === "commands") await session.interrupt();
    });
    expect(kinds(events)).toEqual(["session", "commands", "settled"]);
    expect(events[0]).toMatchObject({ nativeSessionId: "ses_e738d42f2ffeuEpPK5qr36p7wz", model: "opencode/big-pickle" });
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("images are dropped with an info row when the agent lacks promptCapabilities.image", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/simple-turn"]);
    const events = await collect(session.send({ text: "look", images: [{ mediaType: "image/png", data: "AAAA" }] }));
    expect(events.find((event) => event.type === "activity")).toMatchObject({ activity: { kind: "info", text: "1 image dropped: fake-agent does not accept images" } });
    expect(sent(agent, "session/prompt")[0]?.params).toMatchObject({ prompt: [{ type: "text", text: "look" }] });
  });

  it("images are sent as image blocks when the agent accepts them (OpenCode)", async () => {
    const { agent, session } = await open(["opencode-acp-1.1/init", "synthetic/simple-turn"]);
    await collect(session.send({ text: "look", images: [{ mediaType: "image/png", data: "AAAA" }] }));
    expect(sent(agent, "session/prompt")[0]?.params).toMatchObject({ prompt: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
  });

  it("fs: writes outside the worktree are refused, inside are served, terminal/* is method-not-found", async () => {
    const { agent, session, cwd } = await open([CONFIG, "synthetic/fs-write-outside"]);
    const events = await collect(session.send({ text: "write files" }));
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(agent.mismatches).toEqual([]);
    expect(existsSync("/etc/tide-should-not-exist")).toBe(false);
    expect(readFileSync(join(cwd, "inside.txt"), "utf8")).toBe("ok");
    expect(agent.child.received.find((message) => message.id === "fs-1")?.error?.message).toContain("outside the thread's worktree");
  });

  it("auto: permissions are answered by the driver with an audit row", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/tool-permission-accept"], { mode: "auto" });
    const events = await collect(session.send({ text: "go" }));
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(false);
    expect(events.find((event) => event.type === "activity" && event.activity.kind === "info")).toMatchObject({ activity: { text: "auto-approved: Edit hello.txt" } });
    expect(agent.mismatches).toEqual([]);
  });

  it("auto-accept-edits forwards execute permissions", async () => {
    const { session } = await open([CONFIG, "synthetic/permission-declined"], { mode: "auto-accept-edits" });
    const events = await collect(session.send({ text: "go" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "approval") await session.respondApproval(event.activity.requestId, "decline");
    });
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(true);
  });

  it("full-access selects the agent's bypass mode and answers allow_always", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/tool-permission-accept"], { mode: "full-access" });
    expect(sent(agent, "session/set_config_option").map((message) => message.params)).toEqual([{ sessionId: "sess_1", configId: "mode", value: "bypassPermissions" }]);
    await collect(session.send({ text: "go" }));
    expect(agent.child.received.find((message) => message.id === "perm-1")?.result).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
  });

  it("model and effort are applied after session/new through set_config_option", async () => {
    const { agent } = await open([CONFIG], { model: "flash", effort: "high" });
    expect(sent(agent, "session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: "sess_1", configId: "model", value: "flash" },
      { sessionId: "sess_1", configId: "thinking", value: "high" },
    ]);
  });

  it("legacy agents (OpenCode) switch model with session/set_model and mode with session/set_mode", async () => {
    const { agent, session } = await open(["opencode-acp-1.1/init"], { model: "opencode/gpt-5" });
    expect(sent(agent, "session/set_model")[0]?.params).toEqual({ sessionId: "ses_e738d42f2ffeuEpPK5qr36p7wz", modelId: "opencode/gpt-5" });
    expect(await session.reconfigure?.({ mode: "approval-required", interaction: "plan", model: "opencode/gpt-5" })).toBe("applied");
    expect(sent(agent, "session/set_mode")[0]?.params).toEqual({ sessionId: "ses_e738d42f2ffeuEpPK5qr36p7wz", modeId: "plan" });
    expect(await session.reconfigure?.({ mode: "approval-required", interaction: "default" })).toBe("applied");
    expect(sent(agent, "session/set_mode")[1]?.params).toMatchObject({ modeId: "build" });
  });

  it("plan interaction: selects the plan mode and turns the final answer into plan.proposed", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/plan-entries"], { interaction: "plan" });
    expect(sent(agent, "session/set_config_option")[0]?.params).toMatchObject({ configId: "mode", value: "plan" });
    const events = await collect(session.send({ text: "plan it" }));
    expect(kinds(events).slice(-2)).toEqual(["plan.proposed", "settled"]);
    expect(events.at(-2)).toEqual({ type: "plan.proposed", markdown: "## Plan\n1. Read code\n2. Write tests" });
  });

  it("commands seen outside a turn are delivered at the start of the next one", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/simple-turn"]);
    agent.child.send({ method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "compact" }] } } });
    const events = await collect(session.send({ text: "hi" }));
    expect(kinds(events).slice(0, 2)).toEqual(["session", "commands"]);
  });

  it("resume uses session/load and mutes the replayed history", async () => {
    const lines = [...loadFixture(CONFIG).filter((line) => line.method !== "session/new" && line.id !== 1), ...loadFixture("synthetic/load-replay")];
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tide-acp-")));
    const agent = new FixtureAgent([...lines, ...loadFixture("synthetic/simple-turn")]);
    const instance = createAcpInstance({ command: "fake" }, { dataDir: cwd, log: () => undefined }, { spawn: agent.spawn });
    const session = await instance.openSession({ threadId: "t", cwd, resume: "sess_1", mode: "approval-required", interaction: "default", mcpServers: [] });
    expect(sent(agent, "session/new")).toEqual([]);
    expect(sent(agent, "session/load")[0]?.params).toMatchObject({ sessionId: "sess_1", cwd });
    const events = await collect(session.send({ text: "hi" }));
    expect(events.some((event) => event.type === "assistant.delta" && event.delta === "old answer")).toBe(false);
    expect(kinds(events).slice(0, 2)).toEqual(["session", "commands"]);
    expect(await instance.listCommands?.({ cwd })).toEqual([{ name: "compact", description: "compact the session", source: "custom" }]);
  });

  it("systemPromptAppend has no ACP field: it leads the first prompt only", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/simple-turn", "synthetic/simple-turn"], { systemPromptAppend: "Linked repo: lib" });
    await collect(session.send({ text: "one" }));
    await collect(session.send({ text: "two" }));
    const prompts = sent(agent, "session/prompt").map((message) => (message.params as { prompt: unknown[] }).prompt);
    expect(prompts[0]).toEqual([{ type: "text", text: "<tide-context>\nLinked repo: lib\n</tide-context>" }, { type: "text", text: "one" }]);
    expect(prompts[1]).toEqual([{ type: "text", text: "two" }]);
  });

  it("MCP servers are sent in ACP's stdio shape (env as name/value array)", async () => {
    const { agent } = await open([CONFIG], { mcpServers: [{ name: "tide", command: "/usr/bin/node", args: ["mcp.js"], env: { TIDE_TOKEN: "x" } }] });
    expect(sent(agent, "session/new")[0]?.params).toMatchObject({ mcpServers: [{ name: "tide", command: "/usr/bin/node", args: ["mcp.js"], env: [{ name: "TIDE_TOKEN", value: "x" }] }] });
  });

  it("the agent dying mid-turn settles the turn with an error", async () => {
    const { agent, session } = await open([CONFIG]);
    const stream = session.send({ text: "hi" });
    agent.child.exit(1);
    const events = await collect(stream);
    expect(events.at(-1)).toMatchObject({ type: "settled", status: "error" });
  });

  it("close() kills the process and ends a running turn as interrupted", async () => {
    const { agent, session } = await open([CONFIG]);
    const stream = session.send({ text: "hi" });
    await session.close();
    const events = await collect(stream);
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
    expect(agent.child.signals).toEqual(["SIGTERM"]);
    expect(agent.child.stdinEnded).toBe(true);
  });

  it("non-JSON stdout lines are logged and skipped", async () => {
    const { agent, session, logs } = await open([CONFIG, "synthetic/simple-turn"]);
    agent.child.print("Starting agent v1…\n");
    const events = await collect(session.send({ text: "hi" }));
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(logs.some((line) => line.includes("non-JSON stdout line skipped: Starting agent"))).toBe(true);
  });

  it("a second send while a turn runs is refused as busy", async () => {
    const { session } = await open([CONFIG]);
    session.send({ text: "one" });
    expect(() => session.send({ text: "two" })).toThrow(/busy/);
  });
});
