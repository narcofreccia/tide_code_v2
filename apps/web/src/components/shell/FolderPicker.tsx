import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcOutput } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import styles from "./FolderPicker.module.css";

type Listing = RpcOutput<"fs.browse">;

/** `/a/b/c` → [{label:"/", path:"/"}, {label:"a", path:"/a"}, …] */
export function breadcrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let at = "";
  for (const part of parts) {
    at = `${at}/${part}`;
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * Directory browser for "Add a repository". Typing an absolute path into the
 * form still works; this is the affordance for people who would rather look.
 */
export function FolderPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const browse = useCallback(
    (path: string | undefined, hidden: boolean): void => {
      setError(null);
      call("fs.browse", { ...(path === undefined ? {} : { path }), showHidden: hidden })
        .then((result) => {
          setListing(result);
          setActive(0);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [],
  );

  useEffect(() => {
    browse(initialPath === undefined || initialPath.trim() === "" ? undefined : initialPath, showHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-browsing on hidden is handled below
  }, []);

  const dirs = listing?.dirs ?? [];

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.min(dirs.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const next = dirs[active];
      if (next) browse(next.path, showHidden);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      if (listing?.parent !== undefined) browse(listing.parent, showHidden);
    }
  };

  return (
    <Dialog title="Choose a repository folder" onCancel={onClose}>
      <nav className={styles.crumbs} aria-label="Path">
        {(listing ? breadcrumbs(listing.path) : []).map((crumb) => (
          <Button
            key={crumb.path}
            variant="quiet"
            className={styles.crumb}
            onClick={() => browse(crumb.path, showHidden)}
          >
            {crumb.label}
          </Button>
        ))}
      </nav>

      {error ? <p className={styles.error}>{error}</p> : null}

      <ul
        ref={list}
        className={styles.list}
        role="listbox"
        aria-label="Folders"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {listing?.parent === undefined ? null : (
          <li
            role="option"
            aria-selected="false"
            className={styles.row}
            onClick={() => browse(listing.parent, showHidden)}
          >
            <span className={styles.glyph} aria-hidden="true">
              ↑
            </span>
            <span className={styles.name}>..</span>
          </li>
        )}
        {dirs.map((dir, index) => (
          <li
            key={dir.path}
            role="option"
            aria-selected={index === active}
            className={`${styles.row} ${index === active ? styles.active : ""}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => browse(dir.path, showHidden)}
          >
            <span className={styles.glyph} aria-hidden="true">
              {dir.isGitRepo ? "⎇" : "▸"}
            </span>
            <span className={styles.name}>{dir.name}</span>
          </li>
        ))}
        {dirs.length === 0 && listing ? <li className={styles.empty}>No sub-folders here</li> : null}
      </ul>

      {listing && listing.recent.length > 0 ? (
        <div className={styles.recent}>
          <span className={styles.sectionLabel}>Recent</span>
          <ul className={styles.recentList}>
            {listing.recent.map((path) => (
              <li key={path}>
                <Button variant="quiet" className={styles.recentItem} onClick={() => browse(path, showHidden)}>
                  {path}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {listing && !listing.isGitRepo ? (
        <p className={styles.note}>Not a git repository — Tide works best with repos.</p>
      ) : null}

      <div className={styles.actions}>
        <Checkbox
          checked={showHidden}
          onChange={(e) => {
            setShowHidden(e.target.checked);
            browse(listing?.path, e.target.checked);
          }}
        >
          Show hidden folders
        </Checkbox>
        <span className={styles.spacer} />
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={listing === null}
          onClick={() => listing && onPick(listing.path)}
        >
          Use this folder
        </Button>
      </div>
    </Dialog>
  );
}
