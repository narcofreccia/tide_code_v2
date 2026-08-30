import { useUi, type FocusMode } from "../../state/ui.ts";
import styles from "./FocusModeSwitch.module.css";

const MODES: Array<{ mode: FocusMode; glyph: string; hint: string }> = [
  { mode: "thread", glyph: "▯", hint: "Thread only (⌘1)" },
  { mode: "split", glyph: "◫", hint: "Split (⌘2)" },
  { mode: "workbench", glyph: "▮", hint: "Workbench only (⌘3)" },
];

export function FocusModeSwitch() {
  const focusMode = useUi((s) => s.focusMode);
  const setFocusMode = useUi((s) => s.setFocusMode);
  return (
    <div className={styles.group} role="group" aria-label="Focus mode">
      {MODES.map(({ mode, glyph, hint }) => (
        <button
          key={mode}
          type="button"
          title={hint}
          aria-label={hint}
          aria-pressed={focusMode === mode}
          className={`${styles.button} ${focusMode === mode ? styles.active : ""}`}
          onClick={() => setFocusMode(mode)}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}
