import type { DiffFile } from "@tide/contracts";

export type DiffStatus = DiffFile["status"];

export interface RawNumstat {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RawDiffEntry extends RawNumstat {
  status: DiffStatus;
}

function tokens(out: string): string[] {
  return out.split("\0").slice(0, -1); // trailing NUL yields an empty tail
}

/**
 * `git diff --numstat -z`: each record is `adds TAB dels TAB path`, except renames/copies
 * where the record ends after the second TAB and the two following NUL fields are src, dst.
 * Binary files report `-` for both counts.
 */
export function parseNumstat(out: string): RawNumstat[] {
  const parts = tokens(out);
  const result: RawNumstat[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (record === undefined || record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addsRaw = record.slice(0, firstTab);
    const delsRaw = record.slice(firstTab + 1, secondTab);
    const inline = record.slice(secondTab + 1);
    const binary = addsRaw === "-" && delsRaw === "-";
    const additions = binary ? 0 : Number(addsRaw) || 0;
    const deletions = binary ? 0 : Number(delsRaw) || 0;
    if (inline !== "") {
      result.push({ path: inline, additions, deletions, binary });
      continue;
    }
    const oldPath = parts[++i];
    const path = parts[++i];
    if (path === undefined) break;
    result.push({ path, ...(oldPath !== undefined ? { oldPath } : {}), additions, deletions, binary });
  }
  return result;
}

function toStatus(code: string): DiffStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added";
    default:
      return "modified";
  }
}

/** `git diff --name-status -z`: `STATUS \0 path` (renames/copies add a second path). */
export function parseNameStatus(out: string): Map<string, DiffStatus> {
  const parts = tokens(out);
  const map = new Map<string, DiffStatus>();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (code === undefined || code === "") continue;
    const status = toStatus(code);
    if (code.startsWith("R") || code.startsWith("C")) {
      i++; // src
      const dst = parts[++i];
      if (dst !== undefined) map.set(dst, status);
      continue;
    }
    const path = parts[++i];
    if (path !== undefined) map.set(path, status);
  }
  return map;
}
