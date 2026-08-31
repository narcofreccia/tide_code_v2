import { useState } from "react";
import { dispatch } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import { basename, FolderPicker } from "./FolderPicker.tsx";
import styles from "./AddProjectForm.module.css";

export function AddProjectForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const t = title.trim();
    const p = rootPath.trim();
    if (!t || !p) return setError("Title and root path are required");
    if (!p.startsWith("/")) return setError("Root path must be absolute");
    setBusy(true);
    setError(null);
    dispatch({ type: "project.create", title: t, rootPath: p })
      .then(() => {
        setTitle("");
        setRootPath("");
        onDone();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /** Picking a folder names the project too, unless the user already typed a title. */
  const pick = (path: string): void => {
    setRootPath(path);
    setPicking(false);
    setError(null);
    if (title.trim() === "") setTitle(basename(path));
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <span className={styles.heading}>Add a repository</span>
      <p className={styles.hint}>
        A project is a local git repository; threads and worktrees live under it. You can link
        related repositories later from the project card.
      </p>
      <input
        className={styles.input}
        placeholder="Project title"
        aria-label="Project title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <div className={styles.pathRow}>
        <input
          className={`${styles.input} ${styles.mono} ${styles.grow}`}
          placeholder="/absolute/path"
          aria-label="Project root path"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
        />
        <Button onClick={() => setPicking(true)}>Browse…</Button>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          Create
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {picking ? (
        <FolderPicker initialPath={rootPath.trim()} onPick={pick} onClose={() => setPicking(false)} />
      ) : null}
    </form>
  );
}
