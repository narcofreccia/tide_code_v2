import { useState } from "react";
import { call, dispatch } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Radio } from "../ui/Choice.tsx";
import { basename, FolderPicker } from "./FolderPicker.tsx";
import styles from "./AddProjectForm.module.css";

type Mode = "existing" | "new";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Two ways in: add a repository that exists, or start one from nothing. "New project" asks the
 * server to create `<parent>/<name>`, `git init -b main` with an empty first commit and register
 * the project, so the very first thread already gets a worktree and checkpoints.
 */
export function AddProjectForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>("existing");
  const [title, setTitle] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const selectProject = useUi((s) => s.selectProject);

  const finish = (): void => {
    setTitle("");
    setRootPath("");
    setName("");
    onDone();
  };
  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));

  const submitExisting = (): void => {
    const t = title.trim();
    const p = rootPath.trim();
    if (!t || !p) return setError("Title and root path are required");
    if (!p.startsWith("/")) return setError("Root path must be absolute");
    setBusy(true);
    setError(null);
    dispatch({ type: "project.create", title: t, rootPath: p }).then(finish).catch(fail).finally(() => setBusy(false));
  };

  const submitNew = (): void => {
    const parent = parentPath.trim();
    const n = name.trim();
    if (!parent) return setError("Choose where to create the project");
    if (!parent.startsWith("/")) return setError("Parent path must be absolute");
    if (!NAME_RE.test(n)) return setError("Folder name: letters, digits, . _ - only");
    setBusy(true);
    setError(null);
    const t = title.trim();
    call("project.init", { parentPath: parent, name: n, ...(t ? { title: t } : {}) })
      .then((res) => {
        selectProject(res.projectId);
        finish();
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (mode === "existing") submitExisting();
    else submitNew();
  };

  /** Picking a folder names the project too, unless the user already typed a title. */
  const pick = (path: string): void => {
    setPicking(false);
    setError(null);
    if (mode === "existing") {
      setRootPath(path);
      if (title.trim() === "") setTitle(basename(path));
    } else {
      setParentPath(path);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <span className={styles.heading}>{mode === "existing" ? "Add a repository" : "New project"}</span>
      <div className={styles.modes} role="radiogroup" aria-label="Project source">
        <Radio name="project-mode" checked={mode === "existing"} onChange={() => { setMode("existing"); setError(null); }}>
          Existing repository
        </Radio>
        <Radio name="project-mode" checked={mode === "new"} onChange={() => { setMode("new"); setError(null); }}>
          New project
        </Radio>
      </div>
      <p className={styles.hint}>
        {mode === "existing"
          ? "A project is a local git repository; threads and worktrees live under it. You can link related repositories later from the project card."
          : "Tide creates the folder, runs git init on a main branch with an empty first commit, and opens it. The first thread then gets its own worktree, checkpoints and merge-back from the start."}
      </p>
      <input
        className={styles.input}
        placeholder={mode === "existing" ? "Project title" : "Project title (defaults to the folder name)"}
        aria-label="Project title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      {mode === "existing" ? (
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
      ) : (
        <>
          <div className={styles.pathRow}>
            <input
              className={`${styles.input} ${styles.mono} ${styles.grow}`}
              placeholder="/parent/folder"
              aria-label="Parent folder"
              value={parentPath}
              onChange={(e) => setParentPath(e.target.value)}
            />
            <Button onClick={() => setPicking(true)}>Browse…</Button>
          </div>
          <input
            className={`${styles.input} ${styles.mono}`}
            placeholder="folder-name"
            aria-label="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </>
      )}
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {mode === "existing" ? "Create" : "Create project"}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {picking ? (
        <FolderPicker
          initialPath={(mode === "existing" ? rootPath : parentPath).trim()}
          purpose={mode === "existing" ? "repo" : "parent"}
          onPick={pick}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </form>
  );
}
