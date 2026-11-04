import { useRef } from "react";
import { TREE_WIDTH, setTreeWidth, useWorkbench } from "../../../state/workbench.ts";
import styles from "./TreeResizeHandle.module.css";

/** Drag handle on the file tree's right edge: 160–480px, persisted; double-click resets. */
export function TreeResizeHandle() {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  return (
    <div
      className={styles.resize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file tree"
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
