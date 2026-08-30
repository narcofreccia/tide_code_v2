import { Suspense, lazy, useEffect, useState } from "react";
import type { DiffFile, DiffResult } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { parseUnifiedDiff } from "../../lib/diff.ts";
import styles from "./DiffPane.module.css";

/** Monaco is ~MBs; it must never land in the shell chunk. */
const MonacoDiff = lazy(async () => ({ default: (await import("./monaco/MonacoDiff.tsx")).MonacoDiff }));

/** Coloured unified patch — the fallback when Monaco has nothing to diff. */
export function PatchView({ patch }: { patch: string }) {
  return (
    <pre className={styles.patch} data-testid="patch-view">
      {parseUnifiedDiff(patch).map((line, i) => (
        <span key={i} className={styles[line.kind]}>
          {line.text || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

interface Sides {
  original: string;
  modified: string;
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; sides: Sides };

async function fileAt(threadId: string, ref: string, path: string): Promise<string | undefined> {
  const result = await call("vcs.fileAt", { threadId, ref, path });
  if (result.binary || result.missing) return undefined;
  return result.content ?? "";
}

/** Full contents on both sides; `undefined` on a side means "nothing to show". */
function useSides(threadId: string, diff: DiffResult, file: DiffFile): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const key = `${threadId}|${diff.base}|${diff.head}|${file.path}|${file.status}`;

  useEffect(() => {
    let alive = true;
    setLoad({ state: "loading" });
    const oldPath = file.oldPath ?? file.path;
    Promise.all([
      file.status === "added" ? Promise.resolve("") : fileAt(threadId, diff.base, oldPath),
      file.status === "deleted" ? Promise.resolve("") : fileAt(threadId, diff.head, file.path),
    ])
      .then(([original, modified]) => {
        if (!alive) return;
        if (original === undefined || modified === undefined) {
          setLoad({ state: "error", message: "file not available at one of the refs" });
          return;
        }
        setLoad({ state: "ok", sides: { original, modified } });
      })
      .catch((error: unknown) => {
        if (alive) setLoad({ state: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return load;
}

function Fallback({ file, reason }: { file: DiffFile; reason: string }) {
  if (file.patch) return <PatchView patch={file.patch} />;
  return <p className={styles.note}>{reason}</p>;
}

function FileDiff({ threadId, diff, file }: { threadId: string; diff: DiffResult; file: DiffFile }) {
  const sideBySide = useUi((s) => s.diffSideBySide);
  const load = useSides(threadId, diff, file);

  if (file.binary) return <Fallback file={file} reason="Binary file — no textual diff." />;
  if (load.state === "loading") return <p className={styles.note}>Loading diff…</p>;
  if (load.state === "error") return <Fallback file={file} reason={`Could not load file contents: ${load.message}`} />;

  return (
    <div className={styles.editor}>
      <Suspense fallback={<p className={styles.note}>Loading editor…</p>}>
        <MonacoDiff
          path={file.path}
          original={load.sides.original}
          modified={load.sides.modified}
          sideBySide={sideBySide}
        />
      </Suspense>
    </div>
  );
}

/** Right side of the Changes tab: the selected file's diff, read-only in P2. */
export function DiffPane({
  threadId,
  diff,
  file,
}: {
  threadId: string;
  diff: DiffResult | undefined;
  file: DiffFile | undefined;
}) {
  if (!diff || !file) return <p className={styles.note}>Select a file to see its diff.</p>;
  return (
    <div className={styles.pane}>
      <div className={styles.path} title={file.path}>
        {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ""}
        {file.path}
      </div>
      <FileDiff threadId={threadId} diff={diff} file={file} />
    </div>
  );
}
