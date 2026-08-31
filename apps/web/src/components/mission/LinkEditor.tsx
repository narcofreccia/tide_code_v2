import { useState } from "react";
import type { LinkAccess } from "@tide/contracts";
import type { LinkDraft } from "../../lib/linkActions.ts";
import { basename, FolderPicker } from "../shell/FolderPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Radio } from "../ui/Choice.tsx";
import styles from "./ProjectLinks.module.css";

export const NOTE_PLACEHOLDER = "What is this repo? e.g. React web client; calls the API in src/routes";

export function emptyDraft(): LinkDraft {
  return { path: "", label: "", note: "", access: "write" };
}

/**
 * Add / edit form for one linked repository. The path is only editable while
 * adding — moving a link is a remove plus an add, not a rename.
 */
export function LinkEditor({
  mode,
  initial,
  busy = false,
  onSubmit,
  onCancel,
}: {
  mode: "add" | "edit";
  initial: LinkDraft;
  busy?: boolean;
  onSubmit: (draft: LinkDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<LinkDraft>(initial);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (part: Partial<LinkDraft>): void => setDraft((prev) => ({ ...prev, ...part }));
  const radioName = `link-access-${mode}`;

  /** Picking a folder names the link too, unless the user already typed a label. */
  const pick = (path: string): void => {
    setPicking(false);
    setError(null);
    setDraft((prev) => ({ ...prev, path, label: prev.label.trim() === "" ? basename(path) : prev.label }));
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const path = draft.path.trim();
    const label = draft.label.trim() || basename(path);
    if (path === "") return setError("Choose a repository folder");
    if (!path.startsWith("/")) return setError("Path must be absolute");
    if (label === "") return setError("A label is required");
    setError(null);
    onSubmit({ ...draft, path, label });
  };

  return (
    <form className={styles.editor} onSubmit={submit} aria-label={mode === "add" ? "Link a repository" : "Edit link"}>
      {mode === "add" ? (
        <div className={styles.row}>
          <input
            className={`${styles.input} ${styles.mono}`}
            placeholder="/absolute/path"
            aria-label="Repository path"
            value={draft.path}
            onChange={(e) => patch({ path: e.target.value })}
          />
          <Button onClick={() => setPicking(true)}>Browse…</Button>
        </div>
      ) : (
        <span className={styles.path}>{draft.path}</span>
      )}
      <div className={styles.row}>
        <input
          className={styles.input}
          placeholder="Label"
          aria-label="Link label"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </div>
      <input
        className={styles.input}
        placeholder={NOTE_PLACEHOLDER}
        aria-label="Link note"
        value={draft.note}
        onChange={(e) => patch({ note: e.target.value })}
      />
      <div className={styles.row}>
        <Radio
          name={radioName}
          checked={draft.access === "write"}
          onChange={() => patch({ access: "write" as LinkAccess })}
        >
          Read &amp; write
        </Radio>
        <Radio
          name={radioName}
          checked={draft.access === "read"}
          onChange={() => patch({ access: "read" as LinkAccess })}
        >
          Read only
        </Radio>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {mode === "add" ? "Link repository" : "Save"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {picking ? (
        <FolderPicker initialPath={draft.path.trim()} onPick={pick} onClose={() => setPicking(false)} />
      ) : null}
    </form>
  );
}
