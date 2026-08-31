import { afterEach, describe, expect, it } from "vitest";
import { ENV_CWD, ENV_INTERACTION, ENV_LINKED_DIRS, ENV_RUNTIME_MODE, ENV_SYSTEM_PROMPT_APPEND, type LinkedDirWire } from "./protocol.ts";
import tideBridge from "./tide-bridge.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

/** The slice of pi's ExtensionAPI the bridge uses. */
function fakePi(): { pi: Record<string, unknown>; on: Map<string, Handler> } {
  const on = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => on.set(name, handler),
    registerTool: () => undefined,
  };
  return { pi, on };
}

const links: LinkedDirWire[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra", label: "infra", access: "read" },
];

const KEYS = [ENV_RUNTIME_MODE, ENV_INTERACTION, ENV_CWD, ENV_LINKED_DIRS, ENV_SYSTEM_PROMPT_APPEND];
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

function load(env: Record<string, string>): Map<string, Handler> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const { pi, on } = fakePi();
  tideBridge(pi as unknown as Parameters<typeof tideBridge>[0]);
  return on;
}

const toolCall = (on: Map<string, Handler>, toolName: string, input: Record<string, unknown>): Promise<unknown> =>
  on.get("tool_call")!({ toolName, toolCallId: "c1", input }, { ui: { confirm: async () => true }, getContextUsage: () => undefined });

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

  it("registers no system-prompt hook when there is nothing to append", () => {
    expect(load(base).has("before_agent_start")).toBe(false);
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
