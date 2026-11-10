import styles from "./Skeleton.module.css";

/**
 * Placeholder rows while the first snapshot is on its way: "loading", not "empty".
 * Quiet on purpose (no spinner, no copy beyond the accessible name).
 */
export function Skeleton({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={styles.bar} />
      ))}
    </div>
  );
}
