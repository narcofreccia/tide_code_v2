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
/** W1: the thread's cwd, and its linked repos as JSON (`LinkedDirWire[]`). */
export const ENV_CWD = "TIDE_CWD";
export const ENV_LINKED_DIRS = "TIDE_LINKED_DIRS";
/** pi has no `systemPromptAppend` option; the bridge appends this in `before_agent_start`. */
export const ENV_SYSTEM_PROMPT_APPEND = "TIDE_SYSTEM_PROMPT_APPEND";

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
  if (classifyTool(toolName) !== "write") return undefined;
  const path = toolTargetPath(input);
  if (path === undefined) return undefined;
  const target = absolutize(cwd, path);
  return links.find((link) => link.access === "read" && isUnder(link.path, target));
}
