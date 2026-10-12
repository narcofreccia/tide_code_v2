/**
 * The wire contract between `tide-bridge` (inside pi) and `@tide/driver-pi` (outside it).
 * Both sides import this file, so the prefixes and the mode policy have one definition.
 *
 * Transport: pi's extension UI sub-protocol (docs/rpc.md § Extension UI Protocol).
 *  - approvals: `ctx.ui.confirm(title, message)` → `extension_ui_request {method:"confirm"}`,
 *    answered with `extension_ui_response {id, confirmed}`. `message` line 1 is `TIDE_META:<json>`.
 *  - plan / usage: `ctx.ui.notify(text)` → fire-and-forget `extension_ui_request {method:"notify"}`.
 *  - live reconfigure: the driver sends `prompt "/tide-config <json>"`; pi runs extension
 *    commands immediately and answers `disposition:"handled"` without starting a model run
 *    (docs/rpc-commands.md § prompt), so mode / plan mode change in place.
 *  - MCP: `TIDE_MCP_SERVERS` (JSON `McpServerWire[]`) → `pi.registerMcpServer()` at load
 *    (docs/mcp.md § Add servers from extensions). The user's own mcp.json is never touched.
 */

import { isReadOnlyShell } from "./readonly-shell.ts";

export const META_PREFIX = "TIDE_META:";
export const PLAN_PREFIX = "TIDE_PLAN:";
export const USAGE_PREFIX = "TIDE_USAGE:";

export const PLAN_TOOL_NAME = "tide_propose_plan";

/** Env keys the driver sets on the pi process; the extension reads them at load time. */
export const ENV_RUNTIME_MODE = "TIDE_RUNTIME_MODE";
export const ENV_INTERACTION = "TIDE_INTERACTION";
export const ENV_THREAD_ID = "TIDE_THREAD_ID";
/** W1: the thread's cwd, and its linked repos as JSON (`LinkedDirWire[]`). */
export const ENV_CWD = "TIDE_CWD";
export const ENV_LINKED_DIRS = "TIDE_LINKED_DIRS";
/** pi has no `systemPromptAppend` option; the bridge appends this in `before_agent_start`. */
export const ENV_SYSTEM_PROMPT_APPEND = "TIDE_SYSTEM_PROMPT_APPEND";

/** JSON array of `McpServerWire`; the bridge registers each with `pi.registerMcpServer()`. */
export const ENV_MCP_SERVERS = "TIDE_MCP_SERVERS";

/** Extension command the driver uses to change mode / plan mode on a live process. */
export const CONFIG_COMMAND = "tide-config";

export type ToolClass = "read" | "write" | "command" | "unknown";
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface ApprovalMeta {
  requestId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  /** Optional; the driver computes the diff itself so the extension stays thin. */
  diff?: string;
}

const READ_TOOLS = new Set([
  "read", "ls", "grep", "find", "glob", "todo_read", "web_search", "web_fetch",
  // pi 0.99+ built-in MCP resource tools (docs/mcp.md § Use resources: "marked read-only")
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  // pi's tool_search only declares tools; it runs nothing
  "tool_search",
]);
const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit", "todo_write"]);
const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "run_command"]);

/**
 * Unknown tools (the user's own extension tools, MCP tools in P5) are their own class. They
 * are treated as writes for *approval* — ask rather than assume — but they are never hard
 * blocked, because "not in Tide's table" is not evidence that a tool mutates anything, and
 * blocking it would cripple the harness (CLAUDE.md §1a).
 */
export function classifyTool(rawName: string): ToolClass {
  // pi 0.99+ names built-ins `builtin:<name>` in source info; accept either spelling
  const toolName = rawName.startsWith("builtin:") ? rawName.slice("builtin:".length) : rawName;
  if (COMMAND_TOOLS.has(toolName)) return "command";
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "unknown";
}

/** Mirrors the Pi column of the RuntimeMode table in docs/internals/providers.md. */
export function needsApproval(mode: RuntimeMode, toolClass: ToolClass): boolean {
  if (toolClass === "read") return false;
  if (mode === "approval-required") return true;
  // an unknown tool could be a command as easily as an edit, so it keeps asking here
  if (mode === "auto-accept-edits") return toolClass === "command" || toolClass === "unknown";
  return false;
}

/**
 * Is this shell command read-only enough to run while planning? Parse-and-deny (see
 * `readonly-shell.ts`): every simple command must be an allowlisted program without its
 * mutating flags, and no output redirection may reach a file. Anything unrecognised answers
 * `false` and takes the normal approval path — this decides *plan-mode blocking only*, never
 * whether an approval is needed.
 */
export function isReadOnlyCommand(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const command = (input as Record<string, unknown>)["command"];
  return typeof command === "string" && isReadOnlyShell(command);
}

/** In plan mode only these are refused outright; everything else goes to the approval path. */
export function blockedInPlanMode(toolName: string, input: unknown): boolean {
  const toolClass = classifyTool(toolName);
  if (toolClass === "write") return true;
  if (toolClass === "command") return !isReadOnlyCommand(input);
  return false;
}

export function parseRuntimeMode(raw: string | undefined): RuntimeMode {
  if (raw === "auto-accept-edits" || raw === "auto" || raw === "full-access" || raw === "approval-required") return raw;
  // Unset or unknown: the safest mode, so a misconfigured spawn cannot silently run commands.
  return "approval-required";
}

/** Reads the `TIDE_META:` first line of a confirm message. Returns undefined for other dialogs. */
export function parseApprovalMeta(message: string): ApprovalMeta | undefined {
  if (!message.startsWith(META_PREFIX)) return undefined;
  const line = message.slice(META_PREFIX.length).split("\n", 1)[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const meta = parsed as Partial<ApprovalMeta>;
    if (typeof meta.toolName !== "string" || typeof meta.requestId !== "string") return undefined;
    return { requestId: meta.requestId, toolName: meta.toolName, toolCallId: meta.toolCallId ?? "", input: meta.input, ...(meta.diff ? { diff: meta.diff } : {}) };
  } catch {
    return undefined;
  }
}

/** Human-readable remainder of a confirm message (everything after the meta line). */
export function approvalDescription(message: string): string | undefined {
  const newline = message.indexOf("\n");
  if (newline === -1) return undefined;
  const rest = message.slice(newline + 1).trim();
  return rest === "" ? undefined : rest;
}

export function parsePrefixedJson<T>(message: string, prefix: string): T | undefined {
  if (!message.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(message.slice(prefix.length)) as T;
  } catch {
    return undefined;
  }
}

// ---- W1 linked repos -------------------------------------------------------------

export interface LinkedDirWire {
  path: string;
  label: string;
  note?: string;
  access: "read" | "write";
}

export function parseLinkedDirs(raw: string | undefined): LinkedDirWire[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is LinkedDirWire => {
      if (typeof entry !== "object" || entry === null) return false;
      const dir = entry as Partial<LinkedDirWire>;
      return typeof dir.path === "string" && typeof dir.label === "string" && (dir.access === "read" || dir.access === "write");
    });
  } catch {
    return [];
  }
}

/**
 * Pure POSIX/Win32-agnostic containment on already-absolute, `.`/`..`-free segments.
 * `node:path` is deliberately not imported: the extension is transpiled and loaded inside
 * pi, where a bare-module import would have to resolve against pi's own module graph.
 */
function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

export function isUnder(root: string, target: string): boolean {
  const r = segments(root);
  const t = segments(target);
  if (t.length < r.length) return false;
  return r.every((part, i) => t[i] === part);
}

/** Resolves a possibly-relative tool path against the thread's cwd. */
export function absolutize(cwd: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd}/${path}`;
}

const PATH_KEYS = ["path", "file_path", "filePath", "notebook_path"];

export function toolTargetPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * pi has no sandbox and no cwd gate: writes anywhere are possible, so *write* links work
 * natively. The one thing that needs enforcing is the read-only link, and `tool_call` is
 * the hook that can do it (`{block, reason}`). Reads are never blocked.
 */
export function readOnlyLinkFor(toolName: string, input: unknown, cwd: string, links: LinkedDirWire[]): LinkedDirWire | undefined {
  if (links.length === 0) return undefined;
  // `unknown` is included: a tool Tide does not model that names a concrete path under a
  // read-only link is exactly the case the link is meant to stop. Path-less tools are
  // unaffected, so this adds no false blocks.
  const toolClass = classifyTool(toolName);
  if (toolClass !== "write" && toolClass !== "unknown") return undefined;
  const path = toolTargetPath(input);
  if (path === undefined) return undefined;
  const target = absolutize(cwd, path);
  return links.find((link) => link.access === "read" && isUnder(link.path, target));
}

// ---- live reconfigure ---------------------------------------------------------------

export interface BridgeConfig {
  mode: RuntimeMode;
  plan: boolean;
}

export function formatConfigCommand(config: BridgeConfig): string {
  return `/${CONFIG_COMMAND} ${JSON.stringify(config)}`;
}

/** Parses the argument string of `/tide-config`; undefined when it is not a valid config. */
export function parseConfigArgs(args: string): BridgeConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(args.trim());
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record["plan"] !== "boolean" || typeof record["mode"] !== "string") return undefined;
    const mode = parseRuntimeMode(record["mode"]);
    if (mode !== record["mode"]) return undefined;
    return { mode, plan: record["plan"] };
  } catch {
    return undefined;
  }
}

// ---- MCP servers ----------------------------------------------------------------------

export interface McpServerWire {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function parseMcpServers(raw: string | undefined): McpServerWire[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is McpServerWire => {
      if (typeof entry !== "object" || entry === null) return false;
      const server = entry as Partial<McpServerWire>;
      return typeof server.name === "string" && /^[A-Za-z0-9_-]+$/.test(server.name) && typeof server.command === "string";
    });
  } catch {
    return [];
  }
}

/**
 * The `mcpServers` entry handed to `pi.registerMcpServer()`. `exposure: "direct"` because pi's
 * default (`codemode`) hides tools from the model unless codemode is on (docs/mcp.md § Control
 * tool exposure); Tide's board/delegation tools must be callable like Claude's and Codex's.
 */
export function mcpServerConfig(server: McpServerWire): { command: string; args: string[]; env?: Record<string, string>; exposure: "direct"; description: string } {
  return {
    command: server.command,
    args: server.args ?? [],
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    exposure: "direct",
    description: server.name === "tide" ? "Tide: experts board and cross-harness delegation" : `Attached by Tide (${server.name})`,
  };
}
