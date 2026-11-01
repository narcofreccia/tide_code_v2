/*
 * The short, one-line description of a tool call ("Read skills.py", "Bash pnpm test"):
 * shared by the web's live labels and the background-agent selector.
 */

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const TEXT_KEYS = ["pattern", "query", "url", "description", "prompt", "text"];
const TARGET_MAX = 40;

function firstString(input: unknown, keys: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** One line, no quotes, at most 40 characters. */
export function clipTarget(text: string): string {
  const line = (text.split("\n")[0] ?? "").replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  return line.length > TARGET_MAX ? line.slice(0, TARGET_MAX).trimEnd() : line;
}

/** `mcp__tide__tide_delegate` → `Tide_delegate`, `mcp:github.search` → `Search`, `bash` → `Bash`. */
export function displayToolName(toolName: string): string {
  const parts = toolName.split(/__|[:.]/).filter((p) => p !== "");
  const last = parts[parts.length - 1] ?? toolName;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** The short target of a tool call: a path's basename, a command's first 40 characters, else a query. */
export function shortTarget(input: unknown): string | undefined {
  const path = firstString(input, PATH_KEYS);
  if (path !== undefined) {
    const base = path.split(/[\\/]/).filter((p) => p !== "").pop();
    return base === undefined ? undefined : clipTarget(base);
  }
  const command = firstString(input, COMMAND_KEYS) ?? firstString(input, TEXT_KEYS);
  if (command === undefined) return undefined;
  const short = clipTarget(command);
  return short === "" ? undefined : short;
}
