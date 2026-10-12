import type { FsEntry } from "@tide/contracts";
import { fileGlyph } from "../../../lib/fileIcons.ts";
import styles from "./FileTree.module.css";

/** Deeper rows stop indenting; FileTree.module.css carries one rule per level. */
export const MAX_INDENT = 12;

export interface TreeRowModel {
  entry: FsEntry;
  depth: number;
  expanded: boolean;
}

/** One 24px tree line: twisty, glyph, name. Ignored entries are dimmed. */
export function TreeRow({
  row,
  selected,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  row: TreeRowModel;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { entry, depth, expanded } = row;
  const isDir = entry.kind === "dir";
  return (
    <li>
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        {...(isDir ? { "aria-expanded": expanded } : {})}
        aria-level={depth + 1}
        className={[styles.row, selected ? styles.selected : "", entry.ignored ? styles.ignored : ""]
          .filter(Boolean)
          .join(" ")}
        data-depth={Math.min(depth, MAX_INDENT)}
        title={entry.path}
        tabIndex={-1}
        onClick={() => {
          onSelect();
          onOpen();
        }}
        onContextMenu={onContextMenu}
      >
        <span className={styles.twisty}>{isDir ? (expanded ? "▾" : "▸") : ""}</span>
        <span className={styles.glyph}>{fileGlyph(entry.path, entry.kind)}</span>
        <span className={styles.name}>{entry.name}</span>
      </button>
    </li>
  );
}
