import { useRef } from "react";
import { useSeparatorKeys } from "../../../lib/useSeparatorKeys.ts";
import { TREE_WIDTH, setTreeWidth, useWorkbench } from "../../../state/workbench.ts";
import styles from "./TreeResizeHandle.module.css";

/** Drag handle on the file tree's right edge: 160–480px, persisted; double-click resets; ←/→, Home/End from the keyboard. */
export function TreeResizeHandle() {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  const width = useWorkbench((s) => s.treeWidth);
  const keys = useSeparatorKeys({ value: width, min: TREE_WIDTH.min, max: TREE_WIDTH.max, onChange: setTreeWidth });
  return (
    <div
      className={styles.resize}
      aria-label="Resize file tree"
      {...keys}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, width: useWorkbench.getState().treeWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current === undefined) return;
        setTreeWidth(start.current.width + e.clientX - start.current.x);
      }}
      onPointerUp={() => {
        start.current = undefined;
      }}
      onDoubleClick={() => setTreeWidth(TREE_WIDTH.default)}
    />
  );
}
