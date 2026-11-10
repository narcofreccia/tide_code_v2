/**
 * R19 L5: OpenCode refused to resume the session it was asked for.
 *
 * Evidence (opencode 1.19.5, live `opencode serve` with empty XDG dirs): `GET /api/session/<id>`
 * of an unknown id answers HTTP 404
 * `{"_tag":"SessionNotFoundError","sessionID":"<id>","message":"Session not found: <id>"}`
 * (`HttpOpencodeApi` turns it into "opencode GET /api/session/<id> failed: HTTP 404 {…}"). The
 * driver reads the stored session first when resuming, so this is the session being gone (deleted,
 * another server or data dir). A malformed id answers 400 InvalidRequestError and is left alone.
 *
 * The error then carries the machine code `resume-refused: ` (read by the server in
 * `apps/server/src/provider/sessionNotices.ts`), with OpenCode's own words after it.
 */
export const RESUME_REFUSED = "resume-refused";

const NOT_FOUND = /HTTP 404\b.*"_tag"\s*:\s*"SessionNotFoundError"/s;

/** The error reading the resumed session failed with, as the resume-refused error when OpenCode says it is gone. */
export function resumeRefusal(error: unknown): unknown {
  const text = error instanceof Error ? error.message : String(error);
  if (!NOT_FOUND.test(text)) return error;
  const native = text.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? "Session not found";
  return new Error(`${RESUME_REFUSED}: ${native}`, { cause: error });
}
