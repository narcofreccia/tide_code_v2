import styles from "./Pill.module.css";

/** Small uppercase label used for providers, modes and counts. */
export function Pill({ children, tone }: { children: React.ReactNode; tone?: "muted" | "accent" }) {
  return <span className={`${styles.pill} ${tone === "accent" ? styles.accent : ""}`}>{children}</span>;
}
