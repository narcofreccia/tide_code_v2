import { useEffect, useRef } from "react";
import { groupMatches, runSearchNow, setSearchQuery, useSearch, useSearchQuery } from "../../../state/search.ts";
import { openFileTab } from "../../../state/workbench.ts";
import styles from "./SearchPanel.module.css";

function Toggle({
  label,
  title,
  on,
  onClick,
}: {
  label: string;
  title: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.toggle} ${on ? styles.on : ""}`}
      aria-pressed={on}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** `⌘⇧F` pane: debounced `fs.search`, results grouped by file, click to open. */
export function SearchPanel({ threadId }: { threadId: string }) {
  const query = useSearchQuery(threadId);
  const result = useSearch((s) => s.results[threadId]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), [threadId]);

  const groups = groupMatches(result?.data?.matches ?? []);

  return (
    <div className={styles.panel}>
      <div className={styles.controls}>
        <input
          ref={input}
          className={styles.input}
          aria-label="Search"
          placeholder="Search in worktree…"
          value={query.query}
          onChange={(e) => setSearchQuery(threadId, { query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            runSearchNow(threadId);
          }}
        />
        <Toggle
          label="Aa"
          title="Match case"
          on={query.caseSensitive}
          onClick={() => setSearchQuery(threadId, { caseSensitive: !query.caseSensitive })}
        />
        <Toggle
          label=".*"
          title="Regular expression"
          on={query.regex}
          onClick={() => setSearchQuery(threadId, { regex: !query.regex })}
        />
        <input
          className={styles.glob}
          aria-label="Files to include"
          placeholder="glob, e.g. src/**/*.ts"
          value={query.glob}
          onChange={(e) => setSearchQuery(threadId, { glob: e.target.value })}
        />
      </div>

      {result?.error ? <p className={styles.note}>{result.error}</p> : null}
      {result?.loading ? <p className={styles.note}>Searching…</p> : null}
      {!result?.loading && result?.data && groups.length === 0 && query.query.trim() !== "" ? (
        <p className={styles.note}>No results.</p>
      ) : null}
      {result?.data?.truncated ? <p className={styles.note}>Showing the first results only.</p> : null}

      <div className={styles.results}>
        {groups.map((group) => (
          <section key={group.path} className={styles.group}>
            <h3 className={styles.file}>
              <span className={styles.filePath}>{group.path}</span>
              <span className={styles.count}>{group.matches.length}</span>
            </h3>
            <ul className={styles.list}>
              {group.matches.map((match) => (
                <li key={`${match.line}:${match.column}`}>
                  <button
                    type="button"
                    className={styles.match}
                    onClick={() => openFileTab(threadId, match.path, { line: match.line, column: match.column })}
                  >
                    <span className={styles.line}>{match.line}</span>
                    <span className={styles.text}>{match.text.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
