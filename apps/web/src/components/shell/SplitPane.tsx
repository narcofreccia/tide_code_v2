import { useCallback, useEffect, useRef } from "react";
import { useUi } from "../../state/ui.ts";
import styles from "./SplitPane.module.css";

/**
 * Two panes sized by `ui.splitRatio`. The ratio is pushed onto a CSS custom
 * property from an effect so no inline style objects are needed.
 */
export function SplitPane({ primary, secondary }: { primary: React.ReactNode; secondary: React.ReactNode }) {
  const ratio = useUi((s) => s.splitRatio);
  const setSplitRatio = useUi((s) => s.setSplitRatio);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.style.setProperty("--split", `${ratio * 100}%`);
  }, [ratio]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent): void => setSplitRatio((e.clientX - box.left) / box.width);
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [setSplitRatio],
  );

  return (
    <div className={styles.split} ref={root}>
      <div className={styles.pane}>{primary}</div>
      <div
        className={styles.handle}
        role="separator"
        aria-label="Resize thread and workbench"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
      />
      <div className={styles.pane}>{secondary}</div>
    </div>
  );
}
