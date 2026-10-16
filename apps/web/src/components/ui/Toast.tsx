import { dismissToast, useToasts, type ToastItem } from "../../state/toast.ts";
import styles from "./Toast.module.css";

function ActionToast({ toast, action }: { toast: ToastItem; action: NonNullable<ToastItem["action"]> }) {
  return (
    <div className={`${styles.toast} ${styles.withAction}`}>
      <span className={styles.text}>{toast.text}</span>
      <button
        type="button"
        className={styles.action}
        onClick={() => {
          dismissToast(toast.id);
          action.onClick();
        }}
      >
        {action.label}
      </button>
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        ×
      </button>
    </div>
  );
}

/** Bottom-right stack of transient confirmations; some carry one action (Undo). */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((t) =>
        t.action ? (
          <ActionToast key={t.id} toast={t} action={t.action} />
        ) : (
          <button key={t.id} type="button" className={styles.toast} onClick={() => dismissToast(t.id)}>
            {t.text}
          </button>
        ),
      )}
    </div>
  );
}
