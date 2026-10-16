import { useState } from "react";
import styles from "./StageList.module.css";

/**
 * Long text that belongs to one card (persona, stage instructions): a one-line
 * summary that expands into a labelled editor. Empty means "use the default",
 * which is shown as the placeholder rather than pre-filled.
 */
export function StageNote({
  label,
  hint,
  value,
  onChange,
  ariaLabel,
  placeholder,
  emptySummary = "Default",
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder: string;
  emptySummary?: string;
}) {
  const [open, setOpen] = useState(false);
  const custom = value.trim() !== "";
  return (
    <div className={styles.note}>
      <button
        type="button"
        className={styles.noteToggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.noteChevron} aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className={styles.noteLabel}>{label}</span>
        <span className={styles.noteSummary}>{custom ? value.trim() : emptySummary}</span>
      </button>
      {open ? (
        <div className={styles.noteEditor}>
          <textarea
            className={styles.noteText}
            aria-label={ariaLabel}
            placeholder={placeholder}
            value={value}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
          />
          <div className={styles.noteFoot}>
            <span className={styles.noteHint}>{hint}</span>
            {custom ? (
              <button type="button" className={styles.noteAction} onClick={() => onChange("")}>
                Use default
              </button>
            ) : null}
            <button type="button" className={styles.noteAction} onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
