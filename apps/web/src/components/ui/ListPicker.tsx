import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import styles from "./ListPicker.module.css";

/**
 * The option list shared by every picker (⌘K, ⌘P, `@` mentions). Presentational:
 * the owner decides which row is active and what picking means. `pickOn:
 * "mousedown"` keeps focus in an outside textarea (the composer owns its caret).
 */
export function ListPickerList<T>({
  items,
  itemKey,
  renderItem,
  active,
  onActivate,
  onPick,
  label,
  pickOn = "click",
  dense = false,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, active: boolean) => React.ReactNode;
  active: number;
  onActivate?: (index: number) => void;
  onPick: (item: T) => void;
  label: string;
  pickOn?: "click" | "mousedown";
  dense?: boolean;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <ul ref={list} className={styles.list} role="listbox" aria-label={label}>
      {items.map((item, i) => (
        <li key={itemKey(item)}>
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            className={[styles.row, dense ? styles.dense : "", i === active ? styles.active : ""]
              .filter(Boolean)
              .join(" ")}
            onMouseEnter={onActivate ? () => onActivate(i) : undefined}
            {...(pickOn === "mousedown"
              ? {
                  onMouseDown: (e: React.MouseEvent) => {
                    e.preventDefault();
                    onPick(item);
                  },
                }
              : { onClick: () => onPick(item) })}
          >
            {renderItem(item, i === active)}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Clamped cursor movement for ↑/↓; returns undefined for keys it does not own. */
export function stepCursor(key: string, cursor: number, count: number): number | undefined {
  if (key === "ArrowDown") return Math.min(Math.max(0, count - 1), cursor + 1);
  if (key === "ArrowUp") return Math.max(0, cursor - 1);
  return undefined;
}

/**
 * A query box over a fuzzy-ranked list: ↑/↓ move, Enter picks, Escape closes.
 * Ranking defaults to `fuzzyRank` on `text(item)`; pass `rank` for a custom order
 * (the palette folds in recents).
 */
export function ListPicker<T>({
  items,
  itemKey,
  text,
  rank,
  renderItem,
  onPick,
  onClose,
  label,
  inputLabel,
  placeholder,
  limit = 50,
  before,
  after,
  empty,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  /** the string fuzzy-matched against the query (ignored when `rank` is given) */
  text?: (item: T) => string;
  rank?: (query: string, items: readonly T[]) => T[];
  renderItem: (item: T, active: boolean) => React.ReactNode;
  onPick: (item: T) => void;
  onClose: () => void;
  /** accessible name of the listbox */
  label: string;
  /** accessible name of the query box */
  inputLabel: string;
  placeholder?: string;
  limit?: number;
  /** notes rendered between the input and the list (loading, …) */
  before?: React.ReactNode;
  /** notes rendered under the list (truncation, …) */
  after?: React.ReactNode;
  /** shown instead of the list when nothing matches; null hides it */
  empty?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const matches = useMemo(() => {
    if (rank) return rank(query, items).slice(0, limit);
    if (query.trim() === "") return items.slice(0, limit);
    const key = text ?? itemKey;
    return fuzzyRank(query, [...items], key, limit).map((r) => r.item);
  }, [query, items, rank, text, itemKey, limit]);
  const at = Math.min(cursor, Math.max(0, matches.length - 1));

  return (
    <>
      <input
        ref={input}
        className={styles.input}
        aria-label={inputLabel}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          const next = stepCursor(e.key, at, matches.length);
          if (next !== undefined) setCursor(next);
          else if (e.key === "Enter") {
            const item = matches[at];
            if (item !== undefined) onPick(item);
          } else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {before}
      {matches.length === 0 && empty !== null ? (
        <p className={styles.note}>{empty ?? "Nothing matches."}</p>
      ) : null}
      <ListPickerList
        items={matches}
        itemKey={itemKey}
        renderItem={renderItem}
        active={at}
        onActivate={setCursor}
        onPick={onPick}
        label={label}
      />
      {after}
    </>
  );
}

/** Muted one-line note in the picker's own style ("Indexing files…"). */
export function PickerNote({ children }: { children: React.ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}
