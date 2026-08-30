import { readFileSync } from "node:fs";
import { unifiedDiff } from "./diff.ts";

const DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_BYTES = 512 * 1024;

export function isDiffTool(toolName: string): boolean {
  return DIFF_TOOLS.has(toolName);
}

function readCurrent(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_BYTES ? "" : text;
  } catch {
    return "";
  }
}

function applyEdit(source: string, oldString: string, newString: string, replaceAll: boolean): string | undefined {
  if (oldString === "") return newString;
  if (!source.includes(oldString)) return undefined;
  return replaceAll ? source.split(oldString).join(newString) : source.replace(oldString, newString);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Best-effort unified diff for a file-editing tool call, from the proposed input plus the
 * file's current content on disk. Returns undefined whenever anything is uncertain — a
 * wrong diff is worse than none in an approval card.
 */
export function previewDiff(toolName: string, input: Record<string, unknown>): string | undefined {
  const path = str(input["file_path"]) ?? str(input["notebook_path"]);
  if (!path) return undefined;

  if (toolName === "Write") {
    const content = str(input["content"]);
    if (content === undefined) return undefined;
    return unifiedDiff(path, readCurrent(path), content);
  }

  if (toolName === "Edit") {
    const oldString = str(input["old_string"]);
    const newString = str(input["new_string"]);
    if (oldString === undefined || newString === undefined) return undefined;
    const before = readCurrent(path);
    const after = applyEdit(before, oldString, newString, input["replace_all"] === true);
    return after === undefined ? undefined : unifiedDiff(path, before, after);
  }

  if (toolName === "MultiEdit") {
    const edits = input["edits"];
    if (!Array.isArray(edits)) return undefined;
    const before = readCurrent(path);
    let after = before;
    for (const raw of edits) {
      if (typeof raw !== "object" || raw === null) return undefined;
      const edit = raw as Record<string, unknown>;
      const oldString = str(edit["old_string"]);
      const newString = str(edit["new_string"]);
      if (oldString === undefined || newString === undefined) return undefined;
      const next = applyEdit(after, oldString, newString, edit["replace_all"] === true);
      if (next === undefined) return undefined;
      after = next;
    }
    return unifiedDiff(path, before, after);
  }

  // NotebookEdit: cell-level JSON surgery — not worth guessing at, the card shows the input.
  return undefined;
}
