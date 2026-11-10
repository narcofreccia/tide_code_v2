import { JsonRpcError } from "./jsonrpc.ts";

/**
 * R19 L5: Codex refused to resume the thread it was asked for.
 *
 * Evidence (codex-cli 0.166.0, live `codex app-server` with an empty CODEX_HOME): `thread/resume`
 * of an id with no rollout file answers the JSON-RPC error
 * `{code: -32600, message: "no rollout found for thread id <id>"}`. The id is Codex's own, so a
 * missing rollout means the session file is gone, or lives under another CODEX_HOME / machine.
 * A malformed id ("invalid session id: …") is not treated as a refusal.
 *
 * The error then carries the machine code `resume-refused: ` (read by the server in
 * `apps/server/src/provider/sessionNotices.ts`), with Codex's own words after it.
 */
export const RESUME_REFUSED = "resume-refused";

const NO_ROLLOUT = /^no rollout found for thread id\b/i;

/** The error `thread/resume` failed with, as the resume-refused error when Codex says the thread is gone. */
export function resumeRefusal(error: unknown): unknown {
  if (!(error instanceof JsonRpcError) || !NO_ROLLOUT.test(error.message)) return error;
  return new Error(`${RESUME_REFUSED}: ${error.message}`, { cause: error });
}
