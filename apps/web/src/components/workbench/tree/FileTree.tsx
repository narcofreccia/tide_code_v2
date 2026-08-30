import { useEffect, useMemo, useState } from "react";
import type { FsEntry } from "@tide/contracts";
import { ContextMenu, type MenuItem, type MenuPosition } from "../../ui/Menu.tsx";
import { ConfirmDialog, PromptDialog } from "../../ui/Dialog.tsx";
import {
  baseName,
  createEntry,
  deleteEntry,
  dirKey,
  ensureDir,
  joinPath,
  parentDir,
  renameEntry,
  selectRow,
  setExpanded,
  useFiles,
  useFsWatch,
} from "../../../state/files.ts";
import { openFileTab } from "../../../state/workbench.ts";
import { TreeRow, type TreeRowModel } from "./TreeRow.tsx";
import styles from "./FileTree.module.css";

type Pending =
  | { kind: "new-file" | "new-folder"; dir: string }
  | { kind: "rename"; path: string }
  | { kind: "delete"; path: string };

/** Depth-first flatten of the loaded + expanded directories. */
function flatten(
  threadId: string,
  dirs: Record<string, { data?: FsEntry[] }>,
  expanded: Record<string, boolean>,
  dir: string,
  depth: number,
  out: TreeRowModel[],
): void {
  for (const entry of dirs[dirKey(threadId, dir)]?.data ?? []) {
    const open = entry.kind === "dir" && expanded[dirKey(threadId, entry.path)] === true;
    out.push({ entry, depth, expanded: open });
    if (open) flatten(threadId, dirs, expanded, entry.path, depth + 1, out);
  }
}

export function FileTree({ threadId }: { threadId: string }) {
  const dirs = useFiles((s) => s.dirs);
  const expanded = useFiles((s) => s.expanded);
  const selected = useFiles((s) => s.selected[threadId]);
  const [menu, setMenu] = useState<{ position: MenuPosition; path: string; kind: FsEntry["kind"] } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    ensureDir(threadId, "");
  }, [threadId]);
  useFsWatch(threadId);

  const rows = useMemo(() => {
    const out: TreeRowModel[] = [];
    flatten(threadId, dirs, expanded, "", 0, out);
    return out;
  }, [threadId, dirs, expanded]);

  const root = dirs[dirKey(threadId, "")];
  const index = rows.findIndex((r) => r.entry.path === selected);

  const open = (row: TreeRowModel): void => {
    if (row.entry.kind === "dir") setExpanded(threadId, row.entry.path, !row.expanded);
    else openFileTab(threadId, row.entry.path);
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    const at = Math.min(rows.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta));
    const next = rows[at];
    if (next) selectRow(threadId, next.entry.path);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const row = index === -1 ? undefined : rows[index];
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "ArrowRight":
        if (row?.entry.kind === "dir" && !row.expanded) setExpanded(threadId, row.entry.path, true);
        else move(1);
        break;
      case "ArrowLeft":
        if (row?.entry.kind === "dir" && row.expanded) setExpanded(threadId, row.entry.path, false);
        else if (row) {
          const parent = parentDir(row.entry.path);
          if (parent !== "") selectRow(threadId, parent);
        }
        break;
      case "Enter":
        if (row) open(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const menuItems = (path: string, kind: FsEntry["kind"]): MenuItem[] => {
    const dir = kind === "dir" ? path : parentDir(path);
    return [
      { label: "New file", onSelect: () => setPending({ kind: "new-file", dir }) },
      { label: "New folder", onSelect: () => setPending({ kind: "new-folder", dir }) },
      { label: "Rename", separatorBefore: true, onSelect: () => setPending({ kind: "rename", path }) },
      { label: "Delete", danger: true, onSelect: () => setPending({ kind: "delete", path }) },
    ];
  };

  return (
    <div className={styles.tree}>
      <div className={styles.head}>
        <span className={styles.heading}>Files</span>
        <button
          type="button"
          className={styles.action}
          title="New file in the worktree root"
          aria-label="New file"
          onClick={() => setPending({ kind: "new-file", dir: "" })}
        >
          +
        </button>
      </div>
      {root?.error ? <p className={styles.note}>{root.error}</p> : null}
      {root?.loading && rows.length === 0 ? <p className={styles.note}>Loading…</p> : null}
      <ul
        className={styles.list}
        role="tree"
        aria-label="Worktree files"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ position: { x: e.clientX, y: e.clientY }, path: "", kind: "dir" });
        }}
      >
        {rows.map((row) => (
          <TreeRow
            key={row.entry.path}
            row={row}
            selected={row.entry.path === selected}
            onSelect={() => selectRow(threadId, row.entry.path)}
            onOpen={() => open(row)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              selectRow(threadId, row.entry.path);
              setMenu({ position: { x: event.clientX, y: event.clientY }, path: row.entry.path, kind: row.entry.kind });
            }}
          />
        ))}
      </ul>

      {menu ? (
        <ContextMenu
          position={menu.position}
          items={menuItems(menu.path, menu.kind)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {pending?.kind === "new-file" || pending?.kind === "new-folder" ? (
        <PromptDialog
          title={pending.kind === "new-file" ? "New file" : "New folder"}
          label={pending.dir === "" ? "Name" : `Name in ${pending.dir}/`}
          confirmLabel="Create"
          onCancel={() => setPending(null)}
          onSubmit={(name) => {
            const dir = pending.dir;
            const kind = pending.kind === "new-file" ? "file" : "dir";
            setPending(null);
            void createEntry(threadId, joinPath(dir, name), kind).then((ok) => {
              if (ok && kind === "file") openFileTab(threadId, joinPath(dir, name));
              if (ok) setExpanded(threadId, dir, true);
            });
          }}
        />
      ) : null}

      {pending?.kind === "rename" ? (
        <PromptDialog
          title="Rename"
          label="New name"
          initial={baseName(pending.path)}
          confirmLabel="Rename"
          onCancel={() => setPending(null)}
          onSubmit={(name) => {
            const from = pending.path;
            setPending(null);
            void renameEntry(threadId, from, joinPath(parentDir(from), name));
          }}
        />
      ) : null}

      {pending?.kind === "delete" ? (
        <ConfirmDialog
          title="Delete"
          body={<>Delete {pending.path}? This cannot be undone.</>}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const path = pending.path;
            setPending(null);
            void deleteEntry(threadId, path);
          }}
        />
      ) : null}
    </div>
  );
}
