import { useCallback, useEffect, useRef } from "react";
import { useSeparatorKeys, SEPARATOR_STEP_PX } from "../../lib/useSeparatorKeys.ts";
import { useViewport } from "../../lib/useViewport.ts";
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
  const { phone } = useViewport();

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

  // keyboard: the handle's value is the thread pane's share in % (the store clamps it to 20–80)
  const keys = useSeparatorKeys({
    value: ratio * 100,
    min: 20,
    max: 80,
    onChange: (percent) => setSplitRatio(percent / 100),
    step: () => {
      const width = root.current?.getBoundingClientRect().width ?? 0;
      return width > 0 ? (SEPARATOR_STEP_PX / width) * 100 : 2;
    },
  });

  // phone: one column; the workbench opens full-screen from the top bar's Code button
  if (phone) return <div className={styles.pane}>{primary}</div>;

  return (
    <div className={styles.split} ref={root}>
      <div className={styles.pane}>{primary}</div>
      <div className={styles.handle} aria-label="Resize thread and workbench" {...keys} onPointerDown={onPointerDown} />
      <div className={styles.pane}>{secondary}</div>
    </div>
  );
}
