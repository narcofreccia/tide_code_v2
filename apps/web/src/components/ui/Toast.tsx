import { dismissToast, useToasts } from "../../state/toast.ts";
import styles from "./Toast.module.css";

/** Bottom-right stack of transient confirmations. */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={styles.toast} onClick={() => dismissToast(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}
