import type { ReadModel, SearchHit } from "@tide/contracts";

export interface SearchParams {
  q: string;
  projectId?: string;
  limit?: number;
}

export const DEFAULT_SEARCH_LIMIT = 30;
export const SNIPPET_MAX = 160;
const ARCHIVED_PREFIX = "archived:";

/** The line holding the first term (else the first line with any term), cut to SNIPPET_MAX centred on that term. */
export function snippetOf(text: string, terms: string[]): string {
  const lines = text.split(/\r?\n/);
  let line = "";
  let pos = -1;
  let len = 0;
  for (const term of terms) {
    for (const l of lines) {
      const i = l.toLowerCase().indexOf(term);
      if (i >= 0) { line = l; pos = i; len = term.length; break; }
    }
    if (pos >= 0) break;
  }
  if (pos < 0) return text.trim().slice(0, SNIPPET_MAX);
  const trimmed = line.trim();
  pos -= line.length - line.trimStart().length;
  if (trimmed.length <= SNIPPET_MAX) return trimmed;
  const start = Math.max(0, Math.min(pos + Math.floor(len / 2) - Math.floor(SNIPPET_MAX / 2), trimmed.length - SNIPPET_MAX));
  return trimmed.slice(start, start + SNIPPET_MAX);
}

/**
 * One pass over the in-memory model, no index. If this ever gets slow, an FTS table keyed by
 * thread (title + message text) can replace the body while keeping this signature.
 */
export function searchThreads(model: ReadModel, params: SearchParams): SearchHit[] {
  let q = params.q.trim();
  let includeArchived = false;
  if (q.toLowerCase().startsWith(ARCHIVED_PREFIX)) {
    includeArchived = true;
    q = q.slice(ARCHIVED_PREFIX.length).trim();
  }
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
  const hits: SearchHit[] = [];
  for (const thread of Object.values(model.threads)) {
    if (params.projectId !== undefined && thread.projectId !== params.projectId) continue;
    if (!includeArchived && thread.archivedAt !== undefined) continue;
    const title = thread.title.toLowerCase();
    const found = new Set<string>();
    for (const t of terms) if (title.includes(t)) found.add(t);
    const titleHit = found.size > 0;
    let best: { id: string; text: string; at: number } | undefined;
    const ids = model.threadMessages[thread.id] ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = model.messages[ids[i] as string];
      if (!m) continue;
      const text = m.text.toLowerCase();
      let any = false;
      for (const t of terms) if (text.includes(t)) { found.add(t); any = true; }
      if (any && best === undefined) best = { id: m.id, text: m.text, at: m.createdAt };
      if (found.size === terms.length && best !== undefined) break;
    }
    if (found.size < terms.length) continue;
    if (titleHit) hits.push({ threadId: thread.id, projectId: thread.projectId, title: thread.title, snippet: snippetOf(thread.title, terms), field: "title", at: thread.updatedAt });
    else if (best) hits.push({ threadId: thread.id, projectId: thread.projectId, title: thread.title, snippet: snippetOf(best.text, terms), field: "message", messageId: best.id, at: best.at });
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, limit);
}
