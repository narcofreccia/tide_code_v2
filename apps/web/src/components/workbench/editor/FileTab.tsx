import { Suspense, lazy, useEffect, useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { languageLabel } from "../../../lib/language.ts";
import {
  editDoc,
  ensureDoc,
  isDirty,
  loadViewState,
  reloadDoc,
  saveDoc,
  saveViewState,
  useDoc,
} from "../../../state/docs.ts";
import { clearEditorStatus, setEditorStatus, useWorkbench } from "../../../state/workbench.ts";
import styles from "./FileTab.module.css";

/** Monaco is megabytes; it must stay out of the shell chunk. */
const MonacoEditor = lazy(async () => ({ default: (await import("../monaco/MonacoEditor.tsx")).MonacoEditor }));

function Notice({ children }: { children: React.ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

/** One open file: load, edit, save, and reconcile with what the agent writes. */
export function FileTab({ threadId, path }: { threadId: string; path: string }) {
  const doc = useDoc(threadId, path);
  const reveal = useWorkbench((s) => s.reveal[`${threadId}:${path}`]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ensureDoc(threadId, path);
  }, [threadId, path]);

  const dirty = isDirty(doc);
  const editable = doc?.content !== undefined;

  useEffect(() => {
    if (!editable) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveDoc(threadId, path).then((ok) => {
        if (!ok) return;
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [threadId, path, editable]);

  useEffect(() => () => clearEditorStatus(threadId, path), [threadId, path]);

  return (
    <div className={styles.tab}>
      <div className={styles.bar}>
        <span className={styles.path} title={path}>
          {path}
        </span>
        {dirty ? <span className={styles.dirty}>unsaved</span> : null}
        {saved ? <span className={styles.savedFlash}>saved</span> : null}
        <Button
          variant="quiet"
          className={styles.save}
          disabled={!dirty || doc?.saving === true}
          onClick={() => void saveDoc(threadId, path)}
        >
          Save <Kbd>⌘S</Kbd>
        </Button>
      </div>

      {doc?.conflict ? (
        <div className={styles.banner} role="alert">
          <span>Changed on disk — your buffer and the file no longer agree.</span>
          <Button variant="quiet" onClick={() => reloadDoc(threadId, path)}>
            Reload
          </Button>
          <Button variant="primary" onClick={() => void saveDoc(threadId, path, true)}>
            Overwrite
          </Button>
        </div>
      ) : null}

      {doc?.error ? <Notice>{doc.error}</Notice> : null}
      {doc?.binary ? <Notice>Binary file — not shown.</Notice> : null}
      {doc?.tooLarge && !doc.binary ? <Notice>File is larger than 5 MB — not opened in the editor.</Notice> : null}
      {doc?.loading && doc.content === undefined ? <Notice>Loading…</Notice> : null}

      {editable ? (
        <div className={styles.editor}>
          <Suspense fallback={<Notice>Loading editor…</Notice>}>
            <MonacoEditor
              path={path}
              value={doc?.content ?? ""}
              onChange={(next) => editDoc(threadId, path, next)}
              onCursor={(line, column) =>
                setEditorStatus({ threadId, path, line, column, language: languageLabel(path) })
              }
              initialViewState={loadViewState(threadId, path)}
              onSaveViewState={(state) => saveViewState(threadId, path, state)}
              {...(reveal === undefined ? {} : { reveal })}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
