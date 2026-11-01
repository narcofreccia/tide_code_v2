export const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const MAX_LINE = 200;
/** the cause itself (a missing file, a taken port, a panic) beats a generic `error:` summary */
const CAUSE = /panicked|not found|doesn't exist|does not exist|cannot find|no such file|ENOENT|EADDRINUSE/i;
const ERROR = /\berror\b|ERR!/i;
/** the shell echo of `<command>; exit` and an interactive shell's own `exit` line */
const NOISE = /^exit$|;\s*exit$/;

/** The most telling line of a service's output tail: last cause line, else last error line, else last line. */
export function pickErrorLine(tail: string): string | undefined {
  const lines = tail
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim())
    .filter((l) => l.length > 0 && !NOISE.test(l));
  const line = lines.findLast((l) => CAUSE.test(l)) ?? lines.findLast((l) => ERROR.test(l)) ?? lines.at(-1);
  if (line === undefined) return undefined;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** `exited with code 101 — <line>`; a clean exit (no code, or 0, and no signal) is plain `exited`. */
export function exitReason(exit: { code?: number; signal?: string }, tail: string): string {
  const how = exit.signal !== undefined ? `killed by ${exit.signal}` : exit.code !== undefined && exit.code !== 0 ? `exited with code ${exit.code}` : undefined;
  if (how === undefined) return "exited";
  const line = pickErrorLine(tail);
  return line === undefined ? how : `${how} — ${line}`;
}

/** A non-zero code or a signal: the service died on its own, not cleanly. */
export const isFailedExit = (exit: { code?: number; signal?: string }): boolean => exit.signal !== undefined || (exit.code !== undefined && exit.code !== 0);
