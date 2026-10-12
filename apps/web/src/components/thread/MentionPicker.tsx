import { useMemo } from "react";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import { useFileIndex } from "../../state/files.ts";
import { ListPickerList, PickerNote } from "../ui/ListPicker.tsx";
import { PathRow } from "../ui/PathRow.tsx";
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

/** The `@` file picker floating above the composer; the composer owns the caret and cursor. */
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
        <PickerNote>Indexing…</PickerNote>
      </div>
    );
  }
  if (matches.paths.length === 0) return null;

  return (
    <div className={styles.picker}>
      <ListPickerList
        items={matches.paths}
        itemKey={(path) => path}
        renderItem={(path) => <PathRow path={path} />}
        active={cursor}
        onPick={onPick}
        label="Mention a file"
        pickOn="mousedown"
        dense
      />
    </div>
  );
}
