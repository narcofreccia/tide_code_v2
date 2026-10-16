import type { ActivityOf, TurnStatus } from "@tide/contracts";
import { useModel } from "../../../state/model.ts";

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);

/** True once the activity's turn has completed, failed or been interrupted. */
export function useTurnSettled(turnId: string): boolean {
  return useModel((s) => {
    const status = s.model.turns[turnId]?.status;
    return status !== undefined && SETTLED.has(status);
  });
}

/**
 * A harness can drop a sub-agent's closing event (interrupt, crash, a protocol
 * it never sends). Once the turn has settled nothing more will arrive, so a
 * child still marked running is shown as done instead of spinning forever.
 */
export function effectiveChildStatus(
  status: ActivityOf<"child">["status"],
  turnSettled: boolean,
): ActivityOf<"child">["status"] {
  return status === "running" && turnSettled ? "done" : status;
}
