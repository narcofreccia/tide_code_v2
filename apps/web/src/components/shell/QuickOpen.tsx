import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import { fileGlyph } from "../../lib/fileIcons.ts";
import { useFileIndex } from "../../state/files.ts";
import { openFileTab, setQuickOpen } from "../../state/workbench.ts";
import styles from "./QuickOpen.module.css";

const LIMIT = 40;

/** `⌘P`: fuzzy file picker over the thread's cached recursive listing. */
export function QuickOpen({ threadId }: { threadId: string }) {
  const index = useFileIndex(threadId);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const paths = index.data?.paths ?? [];
  const matches = useMemo(
    () => (query.trim() === "" ? paths.slice(0, LIMIT) : fuzzyRank(query, paths, (p) => p, LIMIT).map((r) => r.item)),
    [query, paths],
  );
  const at = Math.min(cursor, Math.max(0, matches.length - 1));

  const choose = (path: string | undefined): void => {
    if (!path) return;
    setQuickOpen(false);
    openFileTab(threadId, path);
  };

  return (
    <div className={styles.scrim} onMouseDown={() => setQuickOpen(false)}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          className={styles.input}
          aria-label="Open file"
          placeholder="Open file…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setCursor((v) => Math.min(matches.length - 1, v + 1));
            else if (e.key === "ArrowUp") setCursor((v) => Math.max(0, v - 1));
            else if (e.key === "Enter") choose(matches[at]);
            else if (e.key === "Escape") setQuickOpen(false);
            else return;
            e.preventDefault();
          }}
        />
        {index.loading && paths.length === 0 ? <p className={styles.note}>Indexing files…</p> : null}
        {!index.loading && matches.length === 0 ? <p className={styles.note}>No matching file.</p> : null}
        <ul className={styles.list} role="listbox" aria-label="Files">
          {matches.map((path, i) => (
            <li key={path}>
              <button
                type="button"
                role="option"
                aria-selected={i === at}
                className={`${styles.row} ${i === at ? styles.active : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(path)}
              >
                <span className={styles.glyph}>{fileGlyph(path)}</span>
                <span className={styles.name}>{path.slice(path.lastIndexOf("/") + 1)}</span>
                <span className={styles.dir}>{path.slice(0, path.lastIndexOf("/"))}</span>
              </button>
            </li>
          ))}
        </ul>
        {index.data?.truncated ? <p className={styles.note}>Index truncated at 20 000 files.</p> : null}
      </div>
    </div>
  );
}
