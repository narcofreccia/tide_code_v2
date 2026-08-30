import { useMemo } from "react";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import { useFileIndex } from "../../state/files.ts";
import styles from "./MentionPicker.module.css";

const LIMIT = 8;

export interface MentionMatches {
  paths: string[];
  indexing: boolean;
}

/** Fuzzy candidates for the composer's `@` picker, from the thread's file index. */
export function useMentionMatches(threadId: string, query: string | undefined): MentionMatches {
  const index = useFileIndex(query === undefined ? undefined : threadId);
  const paths = index.data?.paths ?? [];
  const matches = useMemo(() => {
    if (query === undefined) return [];
    return query === "" ? paths.slice(0, LIMIT) : fuzzyRank(query, paths, (p) => p, LIMIT).map((r) => r.item);
  }, [query, paths]);
  return { paths: matches, indexing: index.loading && paths.length === 0 };
}

/** The `@` file picker floating above the composer; the composer owns the caret. */
export function MentionPicker({
  matches,
  cursor,
  onPick,
}: {
  matches: MentionMatches;
  cursor: number;
  onPick: (path: string) => void;
}) {
  if (matches.indexing) {
    return (
      <div className={styles.picker}>
        <p className={styles.note}>Indexing…</p>
      </div>
    );
  }
  if (matches.paths.length === 0) return null;

  return (
    <div className={styles.picker} role="listbox" aria-label="Mention a file">
      <ul className={styles.list}>
        {matches.paths.map((path, i) => (
          <li key={path}>
            <button
              type="button"
              role="option"
              aria-selected={i === cursor}
              className={`${styles.row} ${i === cursor ? styles.active : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(path);
              }}
            >
              <span className={styles.name}>{path.slice(path.lastIndexOf("/") + 1)}</span>
              <span className={styles.dir}>{path.slice(0, path.lastIndexOf("/"))}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
