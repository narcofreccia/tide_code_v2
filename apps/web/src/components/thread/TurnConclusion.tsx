import { memo } from "react";
import { selectBackgroundAgentsCore } from "@tide/client";
import type { Activity } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { plural } from "../../lib/format.ts";
import styles from "./TurnConclusion.module.css";

/**
 * What a settled turn actually did, counted from its activities — no reading of the
 * reply's prose: "ended · 4 tool calls · 2 sub-agents finished (1 failed)".
 * Tool calls are the main agent's own (a sub-agent's rows and the call that spawned it
 * are not counted twice); a sub-agent the harness never reported back on is listed as
 * "with no result yet" rather than as finished.
 */
export function turnConclusion(activities: Activity[], earlierStillWorking = 0): string {
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
  // the latest turn: "ended" must not read as "all done" while earlier sub-agents still work
  if (earlierStillWorking > 0) parts.push(`${plural(earlierStillWorking, "sub-agent")} from an earlier turn still working`);
  return parts.join(" · ");
}

/** Background sub-agents launched by other turns, counted only on the thread's latest turn (a number: store-safe). */
function useEarlierStillWorking(threadId: string | undefined, turnId: string | undefined): number {
  return useModel((s) => {
    if (threadId === undefined || turnId === undefined || s.model.threads[threadId]?.latestTurnId !== turnId) return 0;
    let n = 0;
    for (const agent of selectBackgroundAgentsCore(s.model, threadId)) if (agent.turnId !== turnId) n += 1;
    return n;
  });
}

/** The muted line under a settled turn's footer. */
export const TurnConclusion = memo(function TurnConclusion({ activities, threadId, turnId }: { activities: Activity[]; threadId?: string; turnId?: string }) {
  const earlier = useEarlierStillWorking(threadId, turnId);
  return (
    <li className={styles.conclusion} data-testid="turn-conclusion">
      {turnConclusion(activities, earlier)}
    </li>
  );
});
