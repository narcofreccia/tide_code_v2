import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_COMMAND,
  ENV_CWD,
  ENV_INTERACTION,
  ENV_LINKED_DIRS,
  ENV_MCP_SERVERS,
  ENV_RUNTIME_MODE,
  ENV_SYSTEM_PROMPT_APPEND,
  META_PREFIX,
  PLAN_PREFIX,
  PLAN_TOOL_NAME,
  USAGE_PREFIX,
  blockedInPlanMode,
  classifyTool,
  mcpServerConfig,
  needsApproval,
  parseConfigArgs,
  parseLinkedDirs,
  parseMcpServers,
  parseRuntimeMode,
  readOnlyLinkFor,
  type BridgeConfig,
  type ToolClass,
} from "./protocol.ts";

/**
 * tide-bridge — the only extension Tide loads into `pi --mode rpc`.
 *
 * A thin translator, never a policy engine (CLAUDE.md §1: no custom safety engine). Jobs:
 *   1. turn Tide's `RuntimeMode` into pi `tool_call` decisions, asking the user through
 *      `ctx.ui.confirm()` — which pi surfaces to the driver as an `extension_ui_request`;
 *   2. report context usage and, in plan mode, the finished plan;
 *   3. in plan mode, keep the agent read-only and give it `tide_propose_plan`;
 *   4. attach Tide's MCP server(s) with `pi.registerMcpServer()` — next to, never instead of,
 *      the user's own `mcp.json` servers;
 *   5. take mode / plan-mode changes live through the `/tide-config` command.
 *
 * The wire contract lives in `protocol.ts`, which the driver imports too.
 */

const PLAN_SYSTEM_PROMPT = [
  "You are in plan mode: do not edit files or run mutating commands;",
  `when your plan is ready call \`${PLAN_TOOL_NAME}\` with the full markdown.`,
].join(" ");

/** One-line human summary, shown when a client renders the confirm dialog itself. */
function summarize(toolName: string, input: Record<string, unknown>): string {
  const command = input["command"];
  if (typeof command === "string") return `Run: ${command}`;
  const path = input["path"] ?? input["file_path"];
  if (typeof path === "string") return `${toolName}: ${path}`;
  return toolName;
}

let counter = 0;
function nextRequestId(): string {
  counter += 1;
  return `tide-approval-${Date.now().toString(36)}-${counter}`;
}

function emitUsage(ctx: ExtensionContext): void {
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens === null) return;
  ctx.ui.notify(`${USAGE_PREFIX}${JSON.stringify({ tokens: usage.tokens, contextWindow: usage.contextWindow })}`, "info");
}

/**
 * Tide's table first; a tool it does not know (MCP, the user's extensions) is a read when its
 * own annotations say so (docs/extensions.md § Tool exposure: MCP tools carry their server's
 * `readOnlyHint`). Hints are the harness's own metadata, so honouring them is surfacing, not
 * policy.
 */
function classify(pi: ExtensionAPI, toolName: string): ToolClass {
  const toolClass = classifyTool(toolName);
  if (toolClass !== "unknown") return toolClass;
  try {
    const hints = pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
    if (hints?.readOnlyHint === true) return "read";
  } catch {
    // getAllTools unavailable (older pi or a test double): stay conservative
  }
  return "unknown";
}

export default function tideBridge(pi: ExtensionAPI): void {
  const config: BridgeConfig = { mode: parseRuntimeMode(process.env[ENV_RUNTIME_MODE]), plan: process.env[ENV_INTERACTION] === "plan" };
  const cwd = process.env[ENV_CWD] ?? process.cwd();
  const links = parseLinkedDirs(process.env[ENV_LINKED_DIRS]);
  const append = process.env[ENV_SYSTEM_PROMPT_APPEND];

  for (const server of parseMcpServers(process.env[ENV_MCP_SERVERS])) {
    try {
      pi.registerMcpServer(server.name, mcpServerConfig(server));
    } catch (error) {
      // A name another extension owns, or a pi without MCP: pi reports registration problems as
      // extension errors too; don't let one bad entry stop the bridge from loading.
      console.error(`[tide-bridge] registerMcpServer(${server.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName === PLAN_TOOL_NAME) return undefined;
    const toolClass = classify(pi, event.toolName);
    if (toolClass === "read") return undefined;

    // W1: pi can write anywhere, so *write* links need nothing; a read-only link is the
    // one rule Tide has to enforce, and this is the hook that can.
    const readOnly = readOnlyLinkFor(event.toolName, event.input, cwd, links);
    if (readOnly) {
      return { block: true, reason: `read-only linked repo: ${readOnly.label} (${readOnly.path}) is linked read-only; do not modify it.` };
    }

    // Plan mode refuses known writes and mutating commands only. A tool Tide does not model
    // is not evidence of a write, and a read-only shell command is research — both take the
    // normal approval path instead of being refused outright (CLAUDE.md §1a).
    if (config.plan && blockedInPlanMode(event.toolName, event.input)) {
      return {
        block: true,
        reason: `Plan mode: \`${event.toolName}\` may not run. Keep researching with read-only tools, then call ${PLAN_TOOL_NAME}.`,
      };
    }
    if (!needsApproval(config.mode, toolClass)) return undefined;

    const input = event.input as Record<string, unknown>;
    const meta = JSON.stringify({ requestId: nextRequestId(), toolName: event.toolName, toolCallId: event.toolCallId, input });
    const confirmed = await ctx.ui.confirm(`Allow ${event.toolName}?`, `${META_PREFIX}${meta}\n${summarize(event.toolName, input)}`);
    return confirmed ? undefined : { block: true, reason: "Denied by the user in Tide" };
  });

  // Context usage after every low-level run. The driver prefers the authoritative
  // `get_session_stats` RPC and falls back to this line when that call is unavailable.
  pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
    emitUsage(ctx);
  });

  // pi's RPC has no `systemPromptAppend`; this hook is the path Tide's preamble (linked repos,
  // plan instructions) takes into the model's system prompt. Registered unconditionally because
  // plan mode can be switched on later; with nothing to add it changes nothing.
  pi.on("before_agent_start", async (event, _ctx) => {
    const extra = [...(append && append.trim() !== "" ? [append] : []), ...(config.plan ? [PLAN_SYSTEM_PROMPT] : [])];
    if (extra.length === 0) return undefined;
    return { systemPrompt: [event.systemPrompt, ...extra].join("\n\n") };
  });

  let planToolRegistered = false;
  const setPlanTool = (on: boolean): void => {
    if (on && !planToolRegistered) {
      planToolRegistered = true;
      // registering a `direct` tool activates it (docs/extensions.md § Tool exposure)
      pi.registerTool({
        name: PLAN_TOOL_NAME,
        label: "Propose plan",
        description: "Record the finished implementation plan. Call this once, with the complete plan as markdown.",
        promptSnippet: "Record the finished implementation plan (plan mode only)",
        parameters: Type.Object({ plan: Type.String({ description: "The complete plan, as markdown" }) }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          ctx.ui.notify(`${PLAN_PREFIX}${JSON.stringify({ plan: params.plan })}`, "info");
          return { content: [{ type: "text", text: "Plan recorded" }], details: {} };
        },
      });
      return;
    }
    if (!planToolRegistered) return;
    const active = pi.getActiveTools().filter((name) => name !== PLAN_TOOL_NAME);
    pi.setActiveTools(on ? [...active, PLAN_TOOL_NAME] : active);
  };
  if (config.plan) setPlanTool(true);

  // Live reconfigure. The driver only sends this between turns; pi runs extension commands
  // without a model call, so nothing reaches the transcript.
  pi.registerCommand(CONFIG_COMMAND, {
    description: "Internal: Tide sets the runtime mode / plan mode of this session",
    handler: async (args, ctx) => {
      const next = parseConfigArgs(args);
      if (!next) {
        ctx.ui.notify(`tide-config: ignored invalid settings ${args.slice(0, 200)}`, "warning");
        return;
      }
      if (next.plan !== config.plan) setPlanTool(next.plan);
      config.mode = next.mode;
      config.plan = next.plan;
    },
  });
}
