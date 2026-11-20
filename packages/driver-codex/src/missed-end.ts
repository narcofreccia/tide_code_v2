import type { NormalizedEvent } from "@tide/contracts";
import { JsonRpcError } from "./jsonrpc.ts";

/** Codex's answer to `turn/steer` / `turn/interrupt` when its thread has no running turn. */
export function isNoActiveTurn(error: unknown): boolean {
  return error instanceof JsonRpcError && /no active turn/i.test(error.message);
}

/** The row shown when the driver settles a turn whose `turn/completed` it never saw. */
export function missedEndNotice(): NormalizedEvent {
  return { type: "activity", activity: { kind: "info", text: "Codex reports this turn already ended; Tide did not see its end" } };
}
