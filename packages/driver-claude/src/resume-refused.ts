/**
 * R19 L5: Claude Code refused to resume the session it was asked for.
 *
 * Evidence (CLI 2.1.322, live, SDK 0.3.296 streaming input with `resume: <unknown uuid>`): the CLI
 * prints "No conversation found with session ID: <id>" on stderr, sends one
 * `result {subtype: "error_during_execution", is_error: true, num_turns: 0,
 * errors: ["No conversation found with session ID: <id>"]}` and exits 1; the SDK iterator then
 * throws "Claude Code returned an error result: No conversation found with session ID: <id>".
 * Every later `send()` resumes the same id and fails the same way until a fresh session.
 *
 * The turn's error then carries the machine code `resume-refused: ` (read by the server in
 * `apps/server/src/provider/sessionNotices.ts`), with Claude Code's own words after it.
 */
export const RESUME_REFUSED = "resume-refused";

const MISSING_CONVERSATION = /No conversation found with session ID:/;

/**
 * `error` with the resume-refused code when the query that failed was opened with `resume` and the
 * CLI says the conversation is gone; any other error is returned as is.
 */
export function markResumeRefused(error: string, resumed: string | undefined): string {
  if (resumed === undefined || error.startsWith(`${RESUME_REFUSED}: `) || !MISSING_CONVERSATION.test(error)) return error;
  const native = error.match(/No conversation found with session ID:[^;\n]*/)?.[0] ?? error;
  return `${RESUME_REFUSED}: ${native.trim()}`;
}
