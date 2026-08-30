import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { unifiedDiff } from "./diff.ts";

/**
 * Approval-card previews for pi's file-mutating tools.
 * pi's schemas (docs of the installed 0.84.x build):
 *   write: { path, content }
 *   edit:  { path, edits: [{ oldText, newText }] }
 * Returns undefined whenever anything is uncertain — a wrong diff is worse than none.
 */

const MAX_BYTES = 512 * 1024;

export function isDiffTool(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

function readCurrent(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_BYTES ? "" : text;
  } catch {
    return "";
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** pi tool paths may be relative to the session cwd. */
function absolute(path: string, cwd: string | undefined): string {
  return isAbsolute(path) || cwd === undefined ? path : resolve(cwd, path);
}

export function previewDiff(toolName: string, input: unknown, cwd?: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const rawPath = str(record["path"]) ?? str(record["file_path"]);
  if (!rawPath) return undefined;
  const path = absolute(rawPath, cwd);

  if (toolName === "write") {
    const content = str(record["content"]);
    if (content === undefined) return undefined;
    return unifiedDiff(rawPath, readCurrent(path), content);
  }

  if (toolName === "edit") {
    const edits = record["edits"];
    if (!Array.isArray(edits) || edits.length === 0) return undefined;
    const before = readCurrent(path);
    let after = before;
    for (const raw of edits) {
      if (typeof raw !== "object" || raw === null) return undefined;
      const edit = raw as Record<string, unknown>;
      const oldText = str(edit["oldText"]);
      const newText = str(edit["newText"]);
      if (oldText === undefined || newText === undefined) return undefined;
      // pi matches each oldText against the ORIGINAL file, so a miss after earlier edits
      // still means our preview would be wrong: bail out.
      if (!before.includes(oldText) || !after.includes(oldText)) return undefined;
      after = after.replace(oldText, newText);
    }
    return unifiedDiff(rawPath, before, after);
  }

  return undefined;
}
