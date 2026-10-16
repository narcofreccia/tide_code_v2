import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.tsx";
import styles from "./Dialog.module.css";

/**
 * Modal shell: centred panel over a scrim, Escape cancels, focus starts inside.
 * `variant="palette"` is the flush, top-anchored look of ⌘K / ⌘P: no padding and
 * no visible title (it stays the accessible name). `variant="sheet"` is the wide,
 * flush panel the composition dialogs fill with a `DialogFrame`, which draws its
 * own sentence heading; `title` stays the accessible name there too.
 */
export function Dialog({
  title,
  onCancel,
  children,
  variant = "form",
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
  variant?: "form" | "palette" | "sheet";
}) {
  const palette = variant === "palette";
  const sheet = variant === "sheet";
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className={`${styles.scrim} ${palette ? styles.paletteScrim : ""} ${sheet ? styles.sheetScrim : ""}`}
      onMouseDown={onCancel}
    >
      <div
        className={palette ? styles.palette : sheet ? styles.sheet : styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {palette || sheet ? null : <h2 className={styles.title}>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/** One-field prompt (new file, rename). Submits on Enter. */
export function PromptDialog({
  title,
  label,
  initial = "",
  confirmLabel = "OK",
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    onSubmit(trimmed);
  };
  return (
    <Dialog title={title} onCancel={onCancel}>
      <label className={styles.field}>
        <span className={styles.label}>{label}</span>
        <input
          ref={input}
          className={styles.input}
          aria-label={label}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
        />
      </label>
      <div className={styles.actions}>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  danger,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog title={title} onCancel={onCancel}>
      <p className={styles.body}>{body}</p>
      <div className={styles.actions}>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
