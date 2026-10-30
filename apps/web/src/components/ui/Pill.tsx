import styles from "./Pill.module.css";

/** `muted` is neutral metadata; the rest map 1:1 onto the `--st-*` status colours. */
export type PillTone = "muted" | "accent" | "running" | "needs" | "ok" | "error" | "limited" | "interrupted" | "idle";

/**
 * Read-only tinted label for state and metadata (providers, counts, phases). Not a control.
 * `size="sm"` is the dense-meta form (`--fs-xs`) for tags inside rows.
 */
export function Pill({
  children,
  tone = "muted",
  size = "md",
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  size?: "sm" | "md";
  title?: string;
  className?: string | undefined;
}) {
  return (
    <span
      className={[styles.pill, styles[tone], size === "sm" ? styles.sm : "", className].filter(Boolean).join(" ")}
      data-size={size}
      {...(title === undefined ? {} : { title })}
    >
      {children}
    </span>
  );
}
