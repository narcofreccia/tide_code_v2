import { useMemo } from "react";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import { THREAD_PREFIX } from "../../lib/mentions.ts";
import { useFileIndex } from "../../state/files.ts";
import { useModel } from "../../state/model.ts";
import { ListPickerList, PickerNote } from "../ui/ListPicker.tsx";
import { PathRow } from "../ui/PathRow.tsx";
import styles from "./MentionPicker.module.css";

const LIMIT = 8;
const THREAD_LIMIT = 5;

export interface ThreadMatch {
  id: string;
  title: string;
}

export type MentionItem = { kind: "file"; path: string } | ({ kind: "thread" } & ThreadMatch);

export interface MentionMatches {
  paths: string[];
  /** R11: live threads of the same project, matched by title */
  threads: ThreadMatch[];
  /** files first, then threads: what ↑/↓ walk through */
  items: MentionItem[];
  indexing: boolean;
}

/** The project's other live threads, newest first; `@thread:` narrows the picker to them. */
function useThreadMatches(threadId: string, projectId: string | undefined, query: string | undefined): ThreadMatch[] {
  const threads = useModel((s) => s.model.threads);
  return useMemo(() => {
    if (query === undefined || projectId === undefined) return [];
    const live = Object.values(threads)
      .filter((t) => t.projectId === projectId && t.id !== threadId && t.archivedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ id: t.id, title: t.title }));
    const q = query.startsWith(THREAD_PREFIX) ? query.slice(THREAD_PREFIX.length) : query;
    if (q === "") return live.slice(0, THREAD_LIMIT);
    return fuzzyRank(q, live, (t) => t.title, THREAD_LIMIT).map((r) => r.item);
  }, [threads, threadId, projectId, query]);
}

/** Candidates for the composer's `@` picker: the thread's file index plus sibling threads. */
export function useMentionMatches(threadId: string, query: string | undefined, projectId?: string): MentionMatches {
  const onlyThreads = query?.startsWith(THREAD_PREFIX) === true;
  const index = useFileIndex(query === undefined || onlyThreads ? undefined : threadId);
  const paths = index.data?.paths ?? [];
  const files = useMemo(() => {
    if (query === undefined || onlyThreads) return [];
    return query === "" ? paths.slice(0, LIMIT) : fuzzyRank(query, paths, (p) => p, LIMIT).map((r) => r.item);
  }, [query, paths, onlyThreads]);
  const threads = useThreadMatches(threadId, projectId, query);
  const items = useMemo<MentionItem[]>(
    () => [...files.map((path) => ({ kind: "file" as const, path })), ...threads.map((t) => ({ kind: "thread" as const, ...t }))],
    [files, threads],
  );
  return { paths: files, threads, items, indexing: !onlyThreads && index.loading && paths.length === 0 };
}

/** The `@` picker floating above the composer; the composer owns the caret and cursor. */
export function MentionPicker({
  matches,
  cursor,
  onPick,
}: {
  matches: MentionMatches;
  cursor: number;
  onPick: (item: MentionItem) => void;
}) {
  const { paths, threads } = matches;
  if (paths.length === 0 && threads.length === 0) {
    return matches.indexing ? (
      <div className={styles.picker}>
        <PickerNote>Indexing…</PickerNote>
      </div>
    ) : null;
  }

  return (
    <div className={styles.picker}>
      {matches.indexing ? <PickerNote>Indexing…</PickerNote> : null}
      {paths.length > 0 ? (
        <ListPickerList
          items={paths}
          itemKey={(path) => path}
          renderItem={(path) => <PathRow path={path} />}
          active={cursor < paths.length ? cursor : -1}
          onPick={(path) => onPick({ kind: "file", path })}
          label="Mention a file"
          pickOn="mousedown"
          dense
        />
      ) : null}
      {threads.length > 0 ? (
        <>
          <p className={styles.section}>Threads</p>
          <ListPickerList
            items={threads}
            itemKey={(t) => t.id}
            renderItem={(t) => (
              <span className={styles.thread}>
                <span aria-hidden="true">💬</span> {t.title}
              </span>
            )}
            active={cursor - paths.length}
            onPick={(t) => onPick({ kind: "thread", ...t })}
            label="Mention a thread"
            pickOn="mousedown"
            dense
          />
        </>
      ) : null}
    </div>
  );
}
