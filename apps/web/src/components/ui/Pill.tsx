import styles from "./Pill.module.css";

/** `muted` is neutral metadata; the rest map 1:1 onto the `--st-*` status colours. */
export type PillTone = "muted" | "accent" | "running" | "needs" | "ok" | "error" | "limited" | "interrupted" | "idle";

/** Read-only tinted label for state and metadata (providers, counts, phases). Not a control. */
export function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: PillTone }) {
  return <span className={`${styles.pill} ${styles[tone] ?? ""}`}>{children}</span>;
}
