import { useEffect, useRef } from "react";
import type { DiffFile } from "@tide/contracts";
import { diffStatus, linkedKey, type LinkedDiffGroup } from "../../lib/linkedDiff.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./FileList.module.css";

const GLYPH: Record<DiffFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { dir: "", base: path } : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

interface Row {
  key: string;
  path: string;
  status: DiffFile["status"];
  additions?: number;
  deletions?: number;
  /** hover text: the absolute path for linked rows */
  title: string;
}

function mainRows(files: DiffFile[]): Row[] {
  return files.map((file) => ({
    key: file.path,
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    title: file.path,
  }));
}

function linkedRows(group: LinkedDiffGroup): Row[] {
  return group.files.map((file) => ({
    key: linkedKey(group, file.path),
    path: file.path,
    status: diffStatus(file.status),
    title: `${group.path.replace(/\/+$/, "")}/${file.path}`,
  }));
}

function FileRow({ row, selected, onSelect }: { row: Row; selected: boolean; onSelect: () => void }) {
  const { dir, base } = splitPath(row.path);
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className={`${styles.row} ${selected ? styles.active : ""}`}
        onClick={onSelect}
        title={row.title}
      >
        <span className={`${styles.glyph} ${styles[row.status]}`} aria-label={row.status}>
          {GLYPH[row.status]}
        </span>
        <span className={styles.path}>
          <span className={styles.dir}>{dir}</span>
          <span className={styles.base}>{base}</span>
        </span>
        {row.additions === undefined && row.deletions === undefined ? null : (
          <span className={styles.stats}>
            <span className={styles.add}>+{row.additions ?? 0}</span>{" "}
            <span className={styles.del}>−{row.deletions ?? 0}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Left column of the Changes tab: one row per changed file, ↑/↓ to move. Files a
 * turn changed in a linked repository follow the main repo's, under a header
 * naming the link.
 */
export function FileList({
  files,
  linked = [],
  selected,
  onSelect,
  onRevertLinked,
  collapsed,
  onToggle,
}: {
  files: DiffFile[];
  /** linked-repo groups, rendered below the main files */
  linked?: LinkedDiffGroup[];
  /** the selected row key: a path for main files, `linkedKey()` for linked ones */
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** absent hides the per-group revert action */
  onRevertLinked?: (group: LinkedDiffGroup) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const rows = [...mainRows(files), ...linked.flatMap(linkedRows)];
  const index = rows.findIndex((r) => r.key === selected);

  useEffect(() => {
    const row = index >= 0 ? list.current?.querySelectorAll("button[role=option]")[index] : null;
    row?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  if (collapsed) {
    return (
      <div className={styles.collapsed}>
        <Button variant="quiet" onClick={onToggle} title="Show files" aria-label="Show files">
          ▸
        </Button>
        <span className={styles.count}>{rows.length}</span>
      </div>
    );
  }

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    const next = rows[Math.min(rows.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))];
    if (next) onSelect(next.key);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.heading}>
          {rows.length} file{rows.length === 1 ? "" : "s"}
        </span>
        <Button variant="quiet" onClick={onToggle} title="Hide files" aria-label="Hide files">
          ◂
        </Button>
      </div>
      <ul
        className={styles.list}
        ref={list}
        role="listbox"
        aria-label="Changed files"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowUp") move(-1);
          else return;
          e.preventDefault();
        }}
      >
        {mainRows(files).map((row) => (
          <FileRow key={row.key} row={row} selected={row.key === selected} onSelect={() => onSelect(row.key)} />
        ))}
        {linked.map((group) => (
          <li key={group.linkId} className={styles.group}>
            <div className={styles.groupHead}>
              <span className={styles.groupLabel} title={group.path}>
                {group.label} <span className={styles.groupPath}>— {group.path}</span>
              </span>
              {onRevertLinked ? (
                <Button
                  variant="quiet"
                  className={styles.revert}
                  onClick={() => onRevertLinked(group)}
                  title={`Revert changes in ${group.label}`}
                >
                  Revert linked changes
                </Button>
              ) : null}
            </div>
            <ul className={styles.groupList}>
              {linkedRows(group).map((row) => (
                <FileRow
                  key={row.key}
                  row={row}
                  selected={row.key === selected}
                  onSelect={() => onSelect(row.key)}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
