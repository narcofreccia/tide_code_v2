import { useEffect, useId, useRef, useState } from "react";
import { useEscape } from "../../lib/useEscape.ts";
import { Button } from "./Button.tsx";
import styles from "./Dialog.module.css";

export type DialogSize = "sm" | "md" | "lg";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && el.closest("[inert]") === null);
}

/**
 * Focus starts inside (an `autoFocus` child keeps it, else the panel itself), Tab and ⇧Tab
 * cycle within the panel, and on close focus goes back to where it was, unless something
 * else has taken it meanwhile (a composer the dialog opened).
 */
function useFocusTrap(panel: React.RefObject<HTMLDivElement | null>): (e: React.KeyboardEvent) => void {
  // read during the first render: by the time effects run an `autoFocus` child already has focus
  const [previous] = useState(() => (typeof document === "undefined" ? null : document.activeElement));
  useEffect(() => {
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const lost = now === null || now === document.body || !now.isConnected || (el?.contains(now) ?? false);
      if (lost && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [panel, previous]);
  return (e) => {
    if (e.key !== "Tab" || e.defaultPrevented || !panel.current) return;
    // the innermost dialog owns Tab; an outer one must not wrap it again
    e.stopPropagation();
    const items = focusables(panel.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * Modal shell: centred panel over a scrim, Escape cancels (`lib/useEscape`: a text field is
 * left first; nested dialogs close one at a time), focus starts inside and is trapped there.
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
  size = "sm",
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
  variant?: "form" | "palette" | "sheet";
  /** width of the `form` panel: 420 / 560 / 760px, never wider than 90vw */
  size?: DialogSize;
}) {
  const palette = variant === "palette";
  const sheet = variant === "sheet";
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // the palette's field is the whole dialog: Esc there closes at once
  useEscape(onCancel, { blurFirst: !palette, root: panel });
  const onKeyDown = useFocusTrap(panel);

  return (
    <div
      className={`${styles.scrim} ${palette ? styles.paletteScrim : ""} ${sheet ? styles.sheetScrim : ""}`}
      onMouseDown={onCancel}
    >
      <div
        ref={panel}
        className={palette ? styles.palette : sheet ? styles.sheet : `${styles.panel} ${styles[size] ?? ""}`}
        data-size={palette || sheet ? undefined : size}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...(palette || sheet ? { "aria-label": title } : { "aria-labelledby": titleId })}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {palette || sheet ? null : (
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        )}
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
  // focus starts on the confirm button, or on Cancel when confirming destroys something
  const cancelFirst = danger === true || confirmDisabled === true;
  return (
    <Dialog title={title} onCancel={onCancel}>
      <p className={styles.body}>{body}</p>
      <div className={styles.actions}>
        <Button variant="quiet" autoFocus={cancelFirst} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} autoFocus={!cancelFirst} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
