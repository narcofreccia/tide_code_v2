import { useUi, type FocusMode } from "../../state/ui.ts";
import styles from "./FocusModeSwitch.module.css";

const MODES: Array<{ mode: FocusMode; label: string; hint: string }> = [
  { mode: "thread", label: "Chat", hint: "Chat only (⌘1)" },
  { mode: "split", label: "Split", hint: "Chat + code (⌘2)" },
  { mode: "workbench", label: "Code", hint: "Code and changes (⌘3)" },
];

/** Only meaningful while a thread's workbench is on screen. */
export function FocusModeSwitch() {
  const focusMode = useUi((s) => s.focusMode);
  const setFocusMode = useUi((s) => s.setFocusMode);
  const view = useUi((s) => s.view);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  if (view !== "thread" || selectedThreadId === null) return null;
  return (
    <div className={styles.group} role="group" aria-label="Focus mode">
      {MODES.map(({ mode, label, hint }) => (
        <button
          key={mode}
          type="button"
          title={hint}
          aria-label={label}
          aria-pressed={focusMode === mode}
          className={`${styles.button} ${focusMode === mode ? styles.active : ""}`}
          onClick={() => setFocusMode(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
