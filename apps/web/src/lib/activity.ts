import type { ActivityOf } from "@tide/contracts";
import type { InboxItem } from "@tide/client";

/** Leading glyph per tool family; unknown tools fall back to ▸ (pass through, don't drop). */
const GLYPHS: [RegExp, string][] = [
  [/^(read|view|cat|notebookread)$/i, "▸"],
  [/^(edit|write|multiedit|patch|apply_patch|notebookedit)$/i, "✎"],
  [/^(bash|shell|exec|run|terminal)$/i, "❯"],
  [/^(grep|glob|search|find|ls)$/i, "⌕"],
  [/^(task|agent|subagent|dispatch)$/i, "◇"],
  [/^(webfetch|websearch|fetch)$/i, "⌁"],
  [/^(todowrite|todo|plan)$/i, "☑"],
];

export function toolGlyph(toolName: string): string {
  for (const [re, glyph] of GLYPHS) if (re.test(toolName)) return glyph;
  return "▸";
}

/** Keeps the tail of a long path readable: `…/src/components/foo.ts`. */
export function shortenPath(path: string, segments = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const TEXT_KEYS = ["pattern", "query", "url", "prompt", "description", "text"];

/** The single most useful thing about a tool call: its path, command or query. */
export function toolTarget(input: unknown): string | undefined {
  const path = firstString(input, PATH_KEYS);
  if (path) return shortenPath(path);
  const command = firstString(input, COMMAND_KEYS);
  if (command) return command.split("\n")[0];
  return firstString(input, TEXT_KEYS);
}

export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const VERBS: [RegExp, string, string][] = [
  [/^(read|view|cat)$/i, "read", "files"],
  [/^(edit|write|multiedit|patch|apply_patch)$/i, "edited", "files"],
  [/^(bash|shell|exec|run)$/i, "ran", "commands"],
  [/^(grep|search)$/i, "searched", "times"],
  [/^(glob|find|ls)$/i, "listed", "paths"],
];

/** "read 4 files" for a same-tool run, "6 tool calls" for a mixed one. */
export function summarizeGroup(activities: ActivityOf<"tool">[]): string {
  const names = new Set(activities.map((a) => a.toolName));
  const count = activities.length;
  const only = names.size === 1 ? [...names][0] : undefined;
  if (only) {
    for (const [re, verb, noun] of VERBS) if (re.test(only)) return `${verb} ${count} ${noun}`;
    return `${only} ×${count}`;
  }
  return `${count} tool calls`;
}

/** Inbox row label: what this thread is waiting on. */
export function describeAttention(item: InboxItem): string {
  if (item.attention === "plan") return "Plan ready";
  if (item.attention === "question") return "Question";
  const activity = item.activity;
  if (activity?.kind !== "approval") return "Approval";
  const target = toolTarget(activity.input);
  return `Approval: ${activity.toolName}${target ? ` ${target}` : ""}`;
}

/** Stringifies a tool input/answer payload for the expanded row. */
export function formatPayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The raw file path a tool acted on, when it has one (Read/Edit/Write …). */
export function toolFilePath(input: unknown): string | undefined {
  return firstString(input, PATH_KEYS);
}
