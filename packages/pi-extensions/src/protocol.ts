/**
 * The wire contract between `tide-bridge` (inside pi) and `@tide/driver-pi` (outside it).
 * Both sides import this file, so the prefixes and the mode policy have one definition.
 *
 * Transport: pi's extension UI sub-protocol (docs/rpc.md § Extension UI Protocol).
 *  - approvals: `ctx.ui.confirm(title, message)` → `extension_ui_request {method:"confirm"}`,
 *    answered with `extension_ui_response {id, confirmed}`. `message` line 1 is `TIDE_META:<json>`.
 *  - plan / usage: `ctx.ui.notify(text)` → fire-and-forget `extension_ui_request {method:"notify"}`.
 */

export const META_PREFIX = "TIDE_META:";
export const PLAN_PREFIX = "TIDE_PLAN:";
export const USAGE_PREFIX = "TIDE_USAGE:";

export const PLAN_TOOL_NAME = "tide_propose_plan";

/** Env keys the driver sets on the pi process; the extension reads them at load time. */
export const ENV_RUNTIME_MODE = "TIDE_RUNTIME_MODE";
export const ENV_INTERACTION = "TIDE_INTERACTION";
export const ENV_THREAD_ID = "TIDE_THREAD_ID";

export type ToolClass = "read" | "write" | "command";
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface ApprovalMeta {
  requestId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  /** Optional; the driver computes the diff itself so the extension stays thin. */
  diff?: string;
}

const READ_TOOLS = new Set(["read", "ls", "grep", "find", "glob", "todo_read", "web_search", "web_fetch"]);
const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit", "todo_write"]);
const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "run_command"]);

/** Unknown tools (extension tools, MCP tools in P5) count as writes: ask rather than assume. */
export function classifyTool(toolName: string): ToolClass {
  if (COMMAND_TOOLS.has(toolName)) return "command";
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "write";
}

/** Mirrors the Pi column of the RuntimeMode table in docs/internals/providers.md. */
export function needsApproval(mode: RuntimeMode, toolClass: ToolClass): boolean {
  if (toolClass === "read") return false;
  if (mode === "approval-required") return true;
  if (mode === "auto-accept-edits") return toolClass === "command";
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
