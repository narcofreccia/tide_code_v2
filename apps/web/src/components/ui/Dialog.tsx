import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.tsx";
import styles from "./Dialog.module.css";

/** Modal shell: centred panel over a scrim, Escape cancels, focus starts inside. */
export function Dialog({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
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
    <div className={styles.scrim} onMouseDown={onCancel}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className={styles.title}>{title}</h2>
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
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
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
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
