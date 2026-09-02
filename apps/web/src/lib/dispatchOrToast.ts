import type { ClientCommand } from "@tide/contracts";
import { dispatch } from "../state/model.ts";
import { showToast } from "../state/toast.ts";

/**
 * A wire error carries a machine `code` and a human `message` (see
 * `RpcCallError` in @tide/client). The message is what the user needs; the code
 * only steps in when the server sent an empty one.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return String(error);
}

/** Runs a promise-returning action and turns a rejection into a visible toast. */
export function runOrToast(label: string, run: () => Promise<unknown>): void {
  void run().catch((error: unknown) => showToast(`${label} failed: ${errorText(error)}`));
}

/**
 * Fire-and-forget command dispatch that never swallows the server's refusal:
 * every rejection becomes `<label> failed: <server message>`.
 */
export function dispatchOrToast(label: string, command: ClientCommand): void {
  runOrToast(label, () => dispatch(command));
}
