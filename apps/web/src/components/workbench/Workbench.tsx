import { ChangesTab } from "./ChangesTab.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import styles from "./Workbench.module.css";

export function Workbench() {
  return (
    <section className={styles.workbench} aria-label="Workbench">
      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab" aria-selected className={`${styles.tab} ${styles.active}`}>
          Changes
        </button>
        <button type="button" role="tab" aria-selected={false} className={styles.tab} disabled>
          Files
        </button>
        <button
          type="button"
          className={styles.terminal}
          disabled
          title="Terminal drawer (coming in P4)"
        >
          Terminal <Kbd>⌘`</Kbd>
        </button>
      </div>
      <ChangesTab />
    </section>
  );
}
