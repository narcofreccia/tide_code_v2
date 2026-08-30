import styles from "./ChangesTab.module.css";

export function ChangesTab() {
  return (
    <div className={styles.tab}>
      <p className={styles.empty}>No changes in this thread yet.</p>
    </div>
  );
}
