import { join, sep } from "node:path";
import type { ReadModel } from "@tide/contracts";
import type { UsageRecord } from "../types.ts";

/**
 * Tide's own turns are already counted from the read model; the harness logs hold the same
 * calls again (Tide drives the harness, the harness writes its log). An external record is
 * Tide's when its session id is one a thread ran, or its cwd sits in a Tide worktree.
 */
export interface Exclusion {
  sessionIds: ReadonlySet<string>;
  cwdPrefixes: readonly string[];
}

export function exclusionFrom(model: ReadModel, tideHome: string | undefined): Exclusion {
  const sessionIds = new Set<string>();
  const cwdPrefixes = new Set<string>();
  if (tideHome !== undefined) cwdPrefixes.add(join(tideHome, "worktrees"));
  for (const t of Object.values(model.threads)) {
    if (t.nativeSessionId !== undefined) sessionIds.add(t.nativeSessionId);
    for (const s of Object.values(t.providerSessions ?? {})) sessionIds.add(s.nativeSessionId);
    if (t.worktreePath !== undefined) cwdPrefixes.add(t.worktreePath);
  }
  return { sessionIds, cwdPrefixes: [...cwdPrefixes] };
}

function under(path: string, prefix: string): boolean {
  const p = prefix.endsWith(sep) ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(p + sep);
}

export function isExcluded(ex: Exclusion, record: Pick<UsageRecord, "sessionId" | "cwd">): boolean {
  if (record.sessionId !== undefined && ex.sessionIds.has(record.sessionId)) return true;
  const cwd = record.cwd;
  return cwd !== undefined && ex.cwdPrefixes.some((p) => under(cwd, p));
}

export function excluder(ex: Exclusion): (record: UsageRecord) => boolean {
  return (record) => isExcluded(ex, record);
}
