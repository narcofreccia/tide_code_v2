import styles from "./Inbox.module.css";

/** Approvals / questions / plans-ready across threads. Empty until P1. */
export function Inbox() {
  return (
    <section className={styles.inbox} aria-label="Inbox">
      <h2 className={styles.heading}>Inbox</h2>
      <p className={styles.empty}>Nothing needs you right now.</p>
    </section>
  );
}
