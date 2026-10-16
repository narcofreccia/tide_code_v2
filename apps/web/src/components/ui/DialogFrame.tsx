import { useId } from "react";
import { Button } from "./Button.tsx";
import { Kbd } from "./Kbd.tsx";
import styles from "./DialogFrame.module.css";

/** ⌘↵ / Ctrl+↵ — the submit chord every composition dialog shares. */
export function isSubmitChord(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/**
 * The composition layout: a sentence heading, a scrolling body, an outcome line
 * and a footer with Cancel + one primary. Lives inside `Dialog variant="sheet"`
 * or a flush `Popover`; ⌘↵ anywhere inside it runs the primary.
 */
export function DialogFrame({
  heading,
  context,
  toolbar,
  children,
  outcome,
  primaryLabel,
  onPrimary,
  blockedReason,
  onCancel,
  bodyTestId,
}: {
  /** the outcome as a sentence, not a noun */
  heading: React.ReactNode;
  /** one quiet line under the heading (project, parent thread) */
  context?: React.ReactNode;
  /** controls that switch what the body shows (Thread | Team) */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  /** what pressing the primary does */
  outcome?: React.ReactNode;
  primaryLabel: string;
  onPrimary: () => void;
  /** set → the primary is disabled and this caption says why */
  blockedReason?: string | undefined;
  onCancel?: () => void;
  bodyTestId?: string;
}) {
  const captionId = useId();
  const blocked = blockedReason !== undefined;
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!isSubmitChord(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!blocked) onPrimary();
  };
  return (
    <div className={styles.frame} onKeyDown={onKeyDown}>
      <header className={styles.header}>
        <h2 className={styles.heading}>{heading}</h2>
        {context === undefined ? null : <p className={styles.context}>{context}</p>}
        {toolbar === undefined ? null : <div className={styles.toolbar}>{toolbar}</div>}
      </header>
      <div className={styles.body} data-testid={bodyTestId}>
        {children}
      </div>
      <footer className={styles.footer}>
        {outcome === undefined ? null : <p className={styles.outcome}>{outcome}</p>}
        <div className={styles.actions}>
          {blocked ? (
            <span id={captionId} className={styles.blocked} role="status">
              {blockedReason}
            </span>
          ) : (
            <span className={styles.chord}>
              <Kbd>⌘↵</Kbd>
            </span>
          )}
          {onCancel === undefined ? null : (
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            className={styles.primary}
            disabled={blocked}
            {...(blocked ? { "aria-describedby": captionId } : {})}
            onClick={onPrimary}
          >
            {primaryLabel}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/** A labelled row: sentence-case label on the left, control and its caption on the right. */
export function FrameField({
  label,
  caption,
  htmlFor,
  children,
}: {
  label: string;
  caption?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.field}>
      {htmlFor === undefined ? (
        <span className={styles.label}>{label}</span>
      ) : (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <div className={styles.control}>
        {children}
        {caption === undefined ? null : <span className={styles.caption}>{caption}</span>}
      </div>
    </div>
  );
}

/** Small sentence-case heading over a group in the body ("Experts", "Stages"). */
export function FrameSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {aside === undefined ? null : <span className={styles.sectionAside}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** The dominant field: topic, task or team name. Focused on open. */
export function PrimaryField({
  label,
  ariaLabel,
  value,
  onChange,
  placeholder,
  multiline = false,
  caption,
  onEnter,
}: {
  /** visible sentence-case label */
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  /** an example, not a question */
  placeholder: string;
  multiline?: boolean;
  caption?: React.ReactNode;
  /** single-line only: plain Enter submits too */
  onEnter?: () => void;
}) {
  const shared = {
    "aria-label": ariaLabel,
    placeholder,
    value,
    autoFocus: true,
    spellCheck: multiline,
  };
  return (
    <label className={styles.primaryField}>
      <span className={styles.label}>{label}</span>
      {multiline ? (
        <textarea
          className={`${styles.primaryInput} ${styles.primaryArea}`}
          rows={2}
          {...shared}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={styles.primaryInput}
          {...shared}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (onEnter === undefined || e.key !== "Enter" || e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            onEnter();
          }}
        />
      )}
      {caption === undefined ? null : <span className={styles.caption}>{caption}</span>}
    </label>
  );
}
