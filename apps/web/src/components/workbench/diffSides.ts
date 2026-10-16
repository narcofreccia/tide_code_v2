import type { DiffFile } from "@tide/contracts";
import type { DiffLine } from "../../lib/diff.ts";

/** Lines of a file's text; the empty file has none (not one empty line). */
export function contentLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

export type DiffView =
  | { kind: "sides"; original: string; modified: string }
  /** every line added (new file) or removed (deleted file); no other side to compare */
  | { kind: "oneSided"; lines: DiffLine[] };

/**
 * How to render one file's diff. Monaco models always hold at least one line,
 * so diffing "" against a new file shows a phantom removed empty line (and the
 * mirror for a deleted file). A one-sided change is rendered as plain added or
 * removed lines instead; the before text of a new file is "" with no lines.
 */
export function diffView(file: Pick<DiffFile, "status">, original: string, modified: string): DiffView {
  const before = file.status === "added" ? "" : original;
  const after = file.status === "deleted" ? "" : modified;
  if (before === "" && after !== "") {
    return { kind: "oneSided", lines: contentLines(after).map((text) => ({ kind: "add", text: `+${text}` })) };
  }
  if (after === "" && before !== "") {
    return { kind: "oneSided", lines: contentLines(before).map((text) => ({ kind: "del", text: `-${text}` })) };
  }
  return { kind: "sides", original: before, modified: after };
}
