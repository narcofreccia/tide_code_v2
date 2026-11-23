/**
 * `@path` mentions in the composer. Paths stay relative to the thread's cwd —
 * every harness resolves relative paths from there — and are sent in backticks
 * so the model reads them as literals rather than prose.
 */
import type { ProviderKind } from "@tide/contracts";

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

/** Replaces the in-progress mention with `@path ` (quoted when `path` contains whitespace) and returns the new caret. */
export function applyMention(text: string, mention: MentionQuery, caret: number, path: string): Insertion {
  const formatted = /\s/.test(path) && !path.startsWith(THREAD_PREFIX) && !path.startsWith(DELEGATE_PREFIX) ? `"${path}"` : path;
  const next = `${text.slice(0, mention.start)}@${formatted} ${text.slice(caret)}`;
  return { text: next, caret: mention.start + formatted.length + 2 };
}

const QUOTED_MENTION = /(^|\s)@"([^"\n]+)"/g;
const MENTION = /(^|\s)@([^\s`"']+)/g;
export const THREAD_PREFIX = "thread:";
export const DELEGATE_PREFIX = "delegate:";

/**
 * Fallback heuristic when no workspace file index is available: looks like a relative file path
 * (e.g. `src/a.ts`, `./Makefile`, `package.json`), never a bare decorator/handle (`@dataclass`,
 * `@alice`) or a 2-segment scoped package (`@tide/server`, `@types/node`).
 */
function looksLikeFilePath(token: string): boolean {
  if (token.startsWith("./") || token.startsWith("../")) return true;
  const slash = token.indexOf("/");
  if (slash >= 0) {
    const last = token.slice(token.lastIndexOf("/") + 1);
    // Scoped packages (`@scope/pkg`) have one slash and no extension; deeper paths or files with a dot are file paths.
    if (token.indexOf("/", slash + 1) >= 0) return true;
    return last.includes(".") && last !== "." && last !== "..";
  }
  // Single segment: must contain a dot (e.g. `package.json`, `README.md`, `.env.example`), not `@dataclass` or `@alice`.
  return token.length > 1 && token.includes(".") && !token.endsWith(".");
}

/**
 * `@src/foo.ts` / `@"my folder/a.ts"` → `` `src/foo.ts` `` just before the turn is dispatched;
 * `@thread:<id>`, `@delegate:…`, scoped packages (`@tide/server`), decorators (`@dataclass`),
 * and handles (`@alice`) are left untouched. When `knownPaths` is provided, any indexed repo path
 * (including extensionless files like `@Makefile`) is also expanded.
 */
export function expandMentions(text: string, knownPaths?: ReadonlySet<string>): string {
  const withQuoted = text.replace(QUOTED_MENTION, (_whole: string, lead: string, path: string) => `${lead}\`${path}\``);
  return withQuoted.replace(MENTION, (whole: string, lead: string, path: string) => {
    if (path.startsWith(THREAD_PREFIX) || path.startsWith(DELEGATE_PREFIX)) return whole;
    if (knownPaths !== undefined && knownPaths.size > 0) {
      return knownPaths.has(path) ? `${lead}\`${path}\`` : whole;
    }
    return looksLikeFilePath(path) ? `${lead}\`${path}\`` : whole;
  });
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

// ---- R17: @delegate:<providerId>[/<model>] cross-harness delegation ----

const DELEGATE_MENTION = /(^|\s)@delegate:([0-9A-Za-z_.-]+(?::[0-9A-Za-z_.-]+)*)(?:\/([^\s`"'(),;]+))?/g;

export interface DelegateTarget {
  providerId: string;
  model?: string;
}

export function delegateMention(providerId: string, model?: string): string {
  return `@${DELEGATE_PREFIX}${providerId}${model === undefined || model === "" ? "" : `/${model}`}`;
}

/** Distinct delegate targets in the text, in order of first appearance. */
export function delegateMentionIds(text: string): DelegateTarget[] {
  const found: DelegateTarget[] = [];
  for (const match of text.matchAll(DELEGATE_MENTION)) {
    const providerId = match[2] ?? "";
    const model = match[3];
    if (providerId === "") continue;
    if (found.some((t) => t.providerId === providerId && t.model === model)) continue;
    found.push(model === undefined ? { providerId } : { providerId, model });
  }
  return found;
}

/** Drops one `@delegate:…` token (every occurrence, plus one following space). */
export function removeDelegateMention(text: string, token: DelegateTarget): string {
  const escaped = delegateMention(token.providerId, token.model).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return text.replace(new RegExp(`(^|\\s)${escaped}(?![^\\s\`"'(),;])(?: )?`, "g"), "$1");
}

export function delegateLine(kind: string, providerId: string, model: string | undefined): string {
  const modelPart = model === undefined ? "" : `, model "${model}"`;
  return `Delegate to: use tide_delegate with provider "${kind}", providerId "${providerId}"${modelPart} for the part of this request addressed to it.`;
}

/**
 * Each `@delegate:…` token becomes `<Label>[ (<model>)]` in place, and one `Delegate to:` line per
 * distinct target is appended, so every harness gets the same unambiguous `tide_delegate` instruction.
 */
export function expandDelegateMentions(
  text: string,
  labelOf: (providerId: string) => { label: string; kind: ProviderKind } | undefined,
): string {
  const targets = delegateMentionIds(text);
  if (targets.length === 0) return text;
  const body = text.replace(DELEGATE_MENTION, (_, lead: string, providerId: string, model: string | undefined) => {
    const label = labelOf(providerId)?.label ?? providerId;
    return `${lead}${label}${model === undefined ? "" : ` (${model})`}`;
  });
  const lines = targets.map((t) => delegateLine(labelOf(t.providerId)?.kind ?? t.providerId, t.providerId, t.model));
  return `${body}\n\n${lines.join("\n")}`;
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
