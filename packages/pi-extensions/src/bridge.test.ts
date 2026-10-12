import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_COMMAND, ENV_CWD, ENV_INTERACTION, ENV_LINKED_DIRS, ENV_MCP_SERVERS, ENV_RUNTIME_MODE, ENV_SYSTEM_PROMPT_APPEND, PLAN_TOOL_NAME, formatConfigCommand, type LinkedDirWire } from "./protocol.ts";
import tideBridge from "./tide-bridge.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

interface Fake {
  pi: Record<string, unknown>;
  on: Map<string, Handler>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  tools: string[];
  active: string[];
  mcp: { name: string; config: Record<string, unknown> }[];
  annotations: Record<string, { readOnlyHint?: boolean }>;
}

/** The slice of pi's ExtensionAPI the bridge uses. */
function fakePi(): Fake {
  const fake: Fake = { pi: {}, on: new Map(), commands: new Map(), tools: [], active: ["read", "bash", "edit", "write"], mcp: [], annotations: {} };
  fake.pi = {
    on: (name: string, handler: Handler) => fake.on.set(name, handler),
    registerTool: (tool: { name: string }) => {
      fake.tools.push(tool.name);
      fake.active.push(tool.name);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => fake.commands.set(name, options.handler),
    registerMcpServer: (name: string, config: Record<string, unknown>) => fake.mcp.push({ name, config }),
    getAllTools: () => Object.entries(fake.annotations).map(([name, annotations]) => ({ name, annotations })),
    getActiveTools: () => [...fake.active],
    setActiveTools: (names: string[]) => {
      fake.active = [...names];
    },
  };
  return fake;
}

const links: LinkedDirWire[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra", label: "infra", access: "read" },
];

const KEYS = [ENV_RUNTIME_MODE, ENV_INTERACTION, ENV_CWD, ENV_LINKED_DIRS, ENV_SYSTEM_PROMPT_APPEND, ENV_MCP_SERVERS];
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

function loadFake(env: Record<string, string>, prepare: (fake: Fake) => void = () => undefined): Fake {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const fake = fakePi();
  prepare(fake);
  tideBridge(fake.pi as unknown as Parameters<typeof tideBridge>[0]);
  return fake;
}

function load(env: Record<string, string>): Map<string, Handler> {
  return loadFake(env).on;
}

const toolCall = (on: Map<string, Handler>, toolName: string, input: Record<string, unknown>): Promise<unknown> =>
  on.get("tool_call")!({ toolName, toolCallId: "c1", input }, { ui: { confirm: async () => true }, getContextUsage: () => undefined });

/** A `tool_call` whose confirm answer the test controls, recording whether it was asked. */
function toolCallAsking(on: Map<string, Handler>, toolName: string, input: Record<string, unknown>, answer = true): { result: Promise<unknown>; asked: string[] } {
  const asked: string[] = [];
  const ctx = { ui: { confirm: async (title: string) => (asked.push(title), answer) }, getContextUsage: () => undefined };
  return { result: on.get("tool_call")!({ toolName, toolCallId: "c1", input }, ctx), asked };
}

describe("tide-bridge plan mode", () => {
  const plan = { [ENV_RUNTIME_MODE]: "approval-required", [ENV_INTERACTION]: "plan", [ENV_CWD]: "/work/repo" };

  it("blocks known writes and mutating commands", async () => {
    const on = load(plan);
    expect(await toolCall(on, "write", { path: "a.ts" })).toMatchObject({ block: true });
    expect(await toolCall(on, "bash", { command: "rm -rf build" })).toMatchObject({ block: true });
  });

  it("lets a tool it does not model reach the approval path instead of refusing it", async () => {
    const on = load(plan);
    // hard-blocking every unmodelled tool made the user's own extension and MCP tools unusable
    // while planning — exactly the crippling CLAUDE.md §1a forbids
    const { result, asked } = toolCallAsking(on, "some_mcp_tool", { q: 1 });
    expect(await result).toBeUndefined();
    expect(asked).toEqual(["Allow some_mcp_tool?"]);
  });

  it("declining an unmodelled tool still blocks it, with the user's reason", async () => {
    const on = load(plan);
    const { result } = toolCallAsking(on, "some_mcp_tool", { q: 1 }, false);
    expect(await result).toMatchObject({ block: true, reason: "Denied by the user in Tide" });
  });

  it("runs read-only shell research without asking or blocking", async () => {
    const on = load({ ...plan, [ENV_RUNTIME_MODE]: "auto" });
    const { result, asked } = toolCallAsking(on, "bash", { command: "git status" });
    expect(await result).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("still enforces the read-only link while planning", async () => {
    const on = load({ ...plan, [ENV_LINKED_DIRS]: JSON.stringify(links) });
    expect(await toolCall(on, "edit", { path: "/repos/infra/main.tf" })).toMatchObject({ block: true, reason: expect.stringContaining("read-only linked repo") });
    // and for a tool Tide does not model that names a path under that link
    expect(await toolCall(on, "some_mcp_tool", { path: "/repos/infra/main.tf" })).toMatchObject({ block: true });
  });
});

describe("tide-bridge linked repos", () => {
  const base = { [ENV_RUNTIME_MODE]: "auto", [ENV_CWD]: "/work/repo", [ENV_LINKED_DIRS]: JSON.stringify(links) };

  it("blocks a write under a read-only link", async () => {
    const on = load(base);
    expect(await toolCall(on, "edit", { path: "/repos/infra/main.tf" })).toMatchObject({ block: true });
    const result = (await toolCall(on, "write", { path: "/repos/infra/new.tf" })) as { reason: string };
    expect(result.reason).toContain("read-only linked repo");
  });

  it("allows a write under a write link and inside the cwd", async () => {
    const on = load(base);
    expect(await toolCall(on, "edit", { path: "/repos/frontend/app.tsx" })).toBeUndefined();
    expect(await toolCall(on, "edit", { path: "src/a.ts" })).toBeUndefined();
  });

  it("allows reads under both kinds of link", async () => {
    const on = load(base);
    expect(await toolCall(on, "read", { path: "/repos/infra/main.tf" })).toBeUndefined();
    expect(await toolCall(on, "grep", { path: "/repos/frontend" })).toBeUndefined();
  });

  it("appends Tide's preamble to pi's own system prompt", async () => {
    const on = load({ ...base, [ENV_SYSTEM_PROMPT_APPEND]: "## Linked repositories\n- infra — /repos/infra (read-only)" });
    const hook = on.get("before_agent_start");
    expect(hook).toBeDefined();
    const result = (await hook!({ systemPrompt: "pi base prompt" }, {})) as { systemPrompt: string };
    expect(result.systemPrompt.startsWith("pi base prompt")).toBe(true);
    expect(result.systemPrompt).toContain("## Linked repositories");
  });

  it("leaves the system prompt alone when there is nothing to append", async () => {
    // the hook is always registered (plan mode can be switched on live) but adds nothing here
    expect(await load(base).get("before_agent_start")!({ systemPrompt: "base" }, {})).toBeUndefined();
  });

  it("keeps plan mode's own instructions alongside the preamble", async () => {
    const on = load({ ...base, [ENV_INTERACTION]: "plan", [ENV_SYSTEM_PROMPT_APPEND]: "## Linked repositories" });
    const result = (await on.get("before_agent_start")!({ systemPrompt: "base" }, {})) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("## Linked repositories");
    expect(result.systemPrompt).toContain("plan mode");
    // plan mode still blocks every write, link or not
    expect(await toolCall(on, "edit", { path: "/repos/frontend/app.tsx" })).toMatchObject({ block: true });
  });
});

describe("tide-bridge MCP", () => {
  it("registers Tide's MCP servers with pi, with direct exposure, and leaves mcp.json alone", () => {
    const servers = [{ name: "tide", command: "node", args: ["mcp.js"], env: { TIDE_AGENT_TOKEN: "t" } }];
    const fake = loadFake({ [ENV_RUNTIME_MODE]: "auto", [ENV_MCP_SERVERS]: JSON.stringify(servers) });
    expect(fake.mcp).toEqual([{ name: "tide", config: expect.objectContaining({ command: "node", args: ["mcp.js"], env: { TIDE_AGENT_TOKEN: "t" }, exposure: "direct" }) }]);
  });

  it("skips malformed entries and survives a registration that throws", () => {
    const fake = loadFake({ [ENV_MCP_SERVERS]: JSON.stringify([{ name: "bad name!", command: "x" }, { name: "ok", command: "x" }]) }, (f) => {
      f.pi["registerMcpServer"] = () => {
        throw new Error("name taken");
      };
    });
    expect(fake.commands.has(CONFIG_COMMAND)).toBe(true);
  });

  it("lets an MCP tool its server marks read-only run without asking", async () => {
    const fake = loadFake({ [ENV_RUNTIME_MODE]: "approval-required" }, (f) => {
      f.annotations["mcp__echo__echo"] = { readOnlyHint: true };
    });
    const { result, asked } = toolCallAsking(fake.on, "mcp__echo__echo", { text: "hi" });
    expect(await result).toBeUndefined();
    expect(asked).toEqual([]);
    // no hint: still asks
    expect(toolCallAsking(fake.on, "mcp__echo__other", {}).asked).toEqual(["Allow mcp__echo__other?"]);
  });
});

describe("tide-bridge live reconfigure (/tide-config)", () => {
  const ctx = { ui: { notify: () => undefined } };

  it("turns plan mode on and off without a restart", async () => {
    const fake = loadFake({ [ENV_RUNTIME_MODE]: "auto", [ENV_INTERACTION]: "default", [ENV_CWD]: "/work/repo" });
    const command = fake.commands.get(CONFIG_COMMAND)!;
    expect(fake.tools).toEqual([]);
    expect(await toolCall(fake.on, "write", { path: "a.ts" })).toBeUndefined();

    await command(formatConfigCommand({ mode: "auto", plan: true }).slice(CONFIG_COMMAND.length + 2), ctx);
    expect(fake.active).toContain(PLAN_TOOL_NAME);
    expect(await toolCall(fake.on, "write", { path: "a.ts" })).toMatchObject({ block: true });
    const prompt = (await fake.on.get("before_agent_start")!({ systemPrompt: "base" }, {})) as { systemPrompt: string };
    expect(prompt.systemPrompt).toContain("plan mode");

    await command(JSON.stringify({ mode: "auto", plan: false }), ctx);
    expect(fake.active).not.toContain(PLAN_TOOL_NAME);
    expect(await toolCall(fake.on, "write", { path: "a.ts" })).toBeUndefined();
    // on again re-activates the already-registered tool instead of registering it twice
    await command(JSON.stringify({ mode: "auto", plan: true }), ctx);
    expect(fake.tools).toEqual([PLAN_TOOL_NAME]);
    expect(fake.active).toContain(PLAN_TOOL_NAME);
  });

  it("changes the runtime mode, and ignores a malformed payload", async () => {
    const fake = loadFake({ [ENV_RUNTIME_MODE]: "auto" });
    const command = fake.commands.get(CONFIG_COMMAND)!;
    expect(toolCallAsking(fake.on, "bash", { command: "rm x" }).asked).toEqual([]);
    await command(JSON.stringify({ mode: "approval-required", plan: false }), ctx);
    expect(toolCallAsking(fake.on, "bash", { command: "rm x" }).asked).toEqual(["Allow bash?"]);
    await command("{not json", ctx);
    await command(JSON.stringify({ mode: "yolo", plan: false }), ctx);
    expect(toolCallAsking(fake.on, "bash", { command: "rm x" }).asked).toEqual(["Allow bash?"]);
  });
});
