import type { Activity } from "@tide/contracts";
import { plural } from "../../lib/format.ts";
import styles from "./TurnConclusion.module.css";

/**
 * What a settled turn actually did, counted from its activities — no reading of the
 * reply's prose: "ended · 4 tool calls · 2 sub-agents finished (1 failed)".
 * Tool calls are the main agent's own (a sub-agent's rows and the call that spawned it
 * are not counted twice); a sub-agent the harness never reported back on is listed as
 * "with no result yet" rather than as finished.
 */
export function turnConclusion(activities: Activity[]): string {
  const childKeys = new Set<string>();
  const childState = new Map<string, string>();
  for (const a of activities) {
    if (a.kind !== "child") continue;
    childKeys.add(a.childKey);
    childState.set(a.childKey, a.status);
  }
  const tools = activities.filter((a) => a.kind === "tool" && a.parentToolUseId === undefined && !childKeys.has(a.toolUseId)).length;
  const states = [...childState.values()];
  const failed = states.filter((s) => s === "error").length;
  const finished = states.filter((s) => s !== "running").length;
  const open = states.length - finished;

  const parts = ["ended"];
  if (tools > 0) parts.push(plural(tools, "tool call"));
  if (finished > 0) parts.push(`${plural(finished, "sub-agent")} finished${failed > 0 ? ` (${failed} failed)` : ""}`);
  if (open > 0) parts.push(`${plural(open, "sub-agent")} with no result yet`);
  if (open > 0) parts[parts.length - 1] += " · the thread continues when they report";
  return parts.join(" · ");
}

/** The muted line under a settled turn's footer. */
export function TurnConclusion({ activities }: { activities: Activity[] }) {
  return (
    <li className={styles.conclusion} data-testid="turn-conclusion">
      {turnConclusion(activities)}
    </li>
  );
}
