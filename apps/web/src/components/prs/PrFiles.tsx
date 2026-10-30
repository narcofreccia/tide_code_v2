import { Suspense, lazy, useState } from "react";
import type { DiffFile } from "@tide/contracts";
import { uniqueByPath } from "../../lib/diffStats.ts";
import { useUi } from "../../state/ui.ts";
import { FileList } from "../workbench/FileList.tsx";
import { PatchView } from "../workbench/DiffPane.tsx";
import { patchSides } from "./patchSides.ts";
import type { Load } from "./usePrDetail.ts";
import type { DiffResult } from "@tide/contracts";
import styles from "./PrDetail.module.css";

/** Monaco is ~MBs; it must never land in the shell chunk. */
const MonacoDiff = lazy(async () => ({ default: (await import("../workbench/monaco/MonacoDiff.tsx")).MonacoDiff }));

function FileDiff({ file }: { file: DiffFile }) {
  const sideBySide = useUi((s) => s.diffSideBySide);
  if (file.binary || !file.patch) return <p className={styles.note}>Binary file — no textual diff.</p>;
  // a new or deleted file has one side only: plain coloured lines read better than an empty pane
  if (file.status === "added" || file.status === "deleted") return <PatchView patch={file.patch} />;
  const sides = patchSides(file.patch);
  return (
    <div className={styles.editor}>
      <Suspense fallback={<p className={styles.note}>Loading editor…</p>}>
        <MonacoDiff path={file.path} original={sides.original} modified={sides.modified} sideBySide={sideBySide} />
      </Suspense>
    </div>
  );
}

/** The PR's Files tab: the workbench's file list beside the diff of the picked file. */
export function PrFiles({ load }: { load: Load<DiffResult> | undefined }) {
  const collapsed = useUi((s) => s.fileListCollapsed);
  const toggleFileList = useUi((s) => s.toggleFileList);
  const [picked, setPicked] = useState<string | undefined>(undefined);

  if (!load || load.state === "loading") return <p className={styles.note}>Loading the diff…</p>;
  if (load.state === "error") return <p className={styles.error}>Could not load the diff: {load.message}</p>;
  const files = uniqueByPath(load.data.files);
  if (files.length === 0) return <p className={styles.note}>No changed files.</p>;
  const file = files.find((f) => f.path === picked) ?? files[0];

  return (
    <div className={styles.files}>
      <FileList files={files} selected={file?.path} onSelect={setPicked} collapsed={collapsed} onToggle={toggleFileList} />
      <div className={styles.diff}>
        {file ? (
          <>
            <div className={styles.path} title={file.path}>
              {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ""}
              {file.path}
            </div>
            <FileDiff file={file} />
          </>
        ) : null}
      </div>
    </div>
  );
}
