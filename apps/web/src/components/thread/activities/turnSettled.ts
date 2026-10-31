import type { TurnStatus } from "@tide/contracts";
import { useModel } from "../../../state/model.ts";

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);

/** True once the activity's turn has completed, failed or been interrupted. */
export function useTurnSettled(turnId: string): boolean {
  return useModel((s) => {
    const status = s.model.turns[turnId]?.status;
    return status !== undefined && SETTLED.has(status);
  });
}
