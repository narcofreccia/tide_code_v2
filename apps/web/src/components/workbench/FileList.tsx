import { useEffect, useRef } from "react";
import type { DiffFile } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import styles from "./FileList.module.css";

const GLYPH: Record<DiffFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { dir: "", base: path } : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

/** Left column of the Changes tab: one row per changed file, ↑/↓ to move. */
export function FileList({
  files,
  selected,
  onSelect,
  collapsed,
  onToggle,
}: {
  files: DiffFile[];
  selected: string | undefined;
  onSelect: (path: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const index = files.findIndex((f) => f.path === selected);

  useEffect(() => {
    const row = index >= 0 ? list.current?.children[index]?.querySelector("button") : null;
    row?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  if (collapsed) {
    return (
      <div className={styles.collapsed}>
        <Button variant="quiet" onClick={onToggle} title="Show files" aria-label="Show files">
          ▸
        </Button>
        <span className={styles.count}>{files.length}</span>
      </div>
    );
  }

  const move = (delta: number): void => {
    if (files.length === 0) return;
    const next = files[Math.min(files.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))];
    if (next) onSelect(next.path);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.heading}>
          {files.length} file{files.length === 1 ? "" : "s"}
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
        {files.map((file) => {
          const { dir, base } = splitPath(file.path);
          return (
            <li key={file.path}>
              <button
                type="button"
                role="option"
                aria-selected={file.path === selected}
                className={`${styles.row} ${file.path === selected ? styles.active : ""}`}
                onClick={() => onSelect(file.path)}
                title={file.path}
              >
                <span className={`${styles.glyph} ${styles[file.status]}`} aria-label={file.status}>
                  {GLYPH[file.status]}
                </span>
                <span className={styles.path}>
                  <span className={styles.dir}>{dir}</span>
                  <span className={styles.base}>{base}</span>
                </span>
                <span className={styles.stats}>
                  <span className={styles.add}>+{file.additions}</span>{" "}
                  <span className={styles.del}>−{file.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
