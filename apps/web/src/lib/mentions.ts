/**
 * `@path` mentions in the composer. Paths stay relative to the thread's cwd —
 * every harness resolves relative paths from there — and are sent in backticks
 * so the model reads them as literals rather than prose.
 */
export interface MentionQuery {
  /** index of the `@` in the text */
  start: number;
  /** text between the `@` and the caret */
  query: string;
}

const STOP = /[\s`"'(),;]/;

/** The `@…` token the caret currently sits in, if any. */
export function findMentionQuery(text: string, caret: number): MentionQuery | undefined {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i] ?? "";
    if (ch === "@") {
      const before = i === 0 ? "" : (text[i - 1] ?? "");
      if (before !== "" && !/\s/.test(before)) return undefined;
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (STOP.test(ch)) return undefined;
  }
  return undefined;
}

export interface Insertion {
  text: string;
  caret: number;
}

/** Replaces the in-progress mention with `@path ` and returns the new caret. */
export function applyMention(text: string, mention: MentionQuery, caret: number, path: string): Insertion {
  const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`;
  return { text: next, caret: mention.start + path.length + 2 };
}

const MENTION = /(^|\s)@([^\s`"']+)/g;

/** `@src/foo.ts` → `` `src/foo.ts` `` just before the turn is dispatched. */
export function expandMentions(text: string): string {
  return text.replace(MENTION, (_, lead: string, path: string) => `${lead}\`${path}\``);
}

/** A pasted absolute path inside the worktree becomes a relative one. */
export function normalizePastedPath(text: string, cwd: string | undefined): string {
  if (!cwd || cwd === "") return text;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (!text.startsWith(prefix)) return text;
  return text.slice(prefix.length);
}
