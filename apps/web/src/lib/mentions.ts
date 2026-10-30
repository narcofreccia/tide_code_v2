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
export const THREAD_PREFIX = "thread:";

/** `@src/foo.ts` → `` `src/foo.ts` `` just before the turn is dispatched; `@thread:<id>` is left alone. */
export function expandMentions(text: string): string {
  return text.replace(MENTION, (whole: string, lead: string, path: string) =>
    path.startsWith(THREAD_PREFIX) ? whole : `${lead}\`${path}\``,
  );
}

// ---- R11: @thread:<id> context mentions ----

/** DataTransfer type a rail thread row carries when dragged; the payload is the thread id. */
export const THREAD_DRAG_TYPE = "text/x-tide-thread";

const THREAD_MENTION = /(^|\s)@thread:([0-9A-Za-z_-]+)/g;

export function threadMention(id: string): string {
  return `@${THREAD_PREFIX}${id}`;
}

/** Distinct thread ids referenced in the text, in order of first appearance. */
export function threadMentionIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(THREAD_MENTION)) {
    const id = match[2] ?? "";
    if (id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Drops every `@thread:<id>` token (and one following space). */
export function removeThreadMention(text: string, id: string): string {
  const escaped = id.replace(/[-]/g, "\\-");
  return text.replace(new RegExp(`(^|\\s)@thread:${escaped}(?![0-9A-Za-z_-]) ?`, "g"), "$1");
}

export function threadContextLine(id: string, title: string): string {
  return `Context thread "${title}" (id ${id}): read it with the tide_thread_read tool before answering.`;
}

/**
 * Each `@thread:<id>` becomes the thread's quoted title in place, and one context line
 * per referenced thread is appended so the agent fetches it with `tide_thread_read`.
 */
export function expandThreadMentions(text: string, titleOf: (id: string) => string | undefined): string {
  const ids = threadMentionIds(text);
  if (ids.length === 0) return text;
  const title = (id: string): string => titleOf(id) ?? id;
  const body = text.replace(THREAD_MENTION, (_, lead: string, id: string) => `${lead}"${title(id)}"`);
  return `${body}\n\n${ids.map((id) => threadContextLine(id, title(id))).join("\n")}`;
}

/** Inserts `text` at the caret with spaces around it as needed; returns the new caret. */
export function insertAt(value: string, caret: number, text: string): Insertion {
  const at = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, at);
  const after = value.slice(at);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const tail = after.startsWith(" ") ? "" : " ";
  const next = `${before}${lead}${text}${tail}${after}`;
  return { text: next, caret: before.length + lead.length + text.length + tail.length };
}

/** A pasted absolute path inside the worktree becomes a relative one. */
export function normalizePastedPath(text: string, cwd: string | undefined): string {
  if (!cwd || cwd === "") return text;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (!text.startsWith(prefix)) return text;
  return text.slice(prefix.length);
}
