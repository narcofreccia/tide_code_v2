import { backgroundChildren, type ActivityOf, type ProviderKind, type ReadModel } from "@tide/contracts";
import { KIND_LABELS } from "../provider/registry.ts";
import type { Engine } from "./engine.ts";

type Child = ActivityOf<"child">;

/**
 * The note a lost background sub-agent is closed with. A background sub-agent lives inside the
 * harness process (Claude Code's `run_in_background` agents are in-process tasks; a `--resume`
 * of the same session id does not bring them back), so once that process is gone the report
 * can never arrive.
 */
export function lostChildSummary(harness: string): string {
  return `No report: the ${harness} session ended before this sub-agent finished`;
}

function harnessOf(model: ReadModel, child: Child): string {
  const kind: ProviderKind | undefined = model.turns[child.turnId]?.provider ?? model.threads[child.threadId]?.provider;
  return kind !== undefined ? KIND_LABELS[kind] : "harness";
}

/**
 * Newest sign of life of the thread's background sub-agents: a child row or a tool row one of
 * them made (`parentToolUseId` = the child's key). undefined when nothing runs in the background.
 */
export function backgroundActivityAt(model: ReadModel, threadId: string): number | undefined {
  const children = backgroundChildren(model, threadId);
  if (children.length === 0) return undefined;
  const keys = new Set(children.map((c) => c.childKey));
  let last = Math.max(...children.map((c) => c.updatedAt));
  for (const entry of model.threadTimeline[threadId] ?? []) {
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (a?.kind === "tool" && a.parentToolUseId != null && keys.has(a.parentToolUseId)) last = Math.max(last, a.updatedAt);
  }
  return last;
}

/** The final rows of a thread's background sub-agents whose harness process is gone. Pure. */
export function lostChildUpserts(model: ReadModel, threadId: string, now: number): Child[] {
  return backgroundChildren(model, threadId).map((c) => ({ ...c, status: "error", summary: lostChildSummary(harnessOf(model, c)), updatedAt: now }));
}

/**
 * Closes a thread's background sub-agents as failed with no report. Call it only once the
 * harness process that ran them is gone (session closed, reaped, server restarted): while it
 * lives, a sub-agent can still report. Returns how many rows were closed.
 */
export async function markChildrenLost(
  engine: Pick<Engine, "dispatch" | "getModel">,
  threadId: string,
  options: { now?: () => number; log?: (msg: string, data?: unknown) => void } = {},
): Promise<number> {
  const now = options.now ?? (() => Date.now());
  let count = 0;
  for (const activity of lostChildUpserts(engine.getModel(), threadId, now())) {
    try {
      await engine.dispatch({ type: "activity.upsert", activity });
      count++;
    } catch (err) {
      options.log?.("[background] closing a lost sub-agent failed", err);
    }
  }
  return count;
}
