import styles from "./BottomSheet.module.css";

/** A modal panel pinned to the bottom edge; the backdrop and Done close it. */
export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <span className={styles.title}>{title}</span>
          <button type="button" className={styles.done} onClick={onClose}>
            Done
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
