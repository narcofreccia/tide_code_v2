import { useId } from "react";
import { rowId } from "./saved.ts";
import styles from "./settings.module.css";

/**
 * Label (and help) on the left, the control right-aligned; stacks under 560px. Pass `control` as a
 * function to get an id for the control, and the label becomes its `<label for>`.
 */
export function SettingRow({
  label,
  help,
  control,
  htmlFor,
  danger = false,
  extra,
  id,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  control?: React.ReactNode | ((id: string) => React.ReactNode);
  htmlFor?: string;
  danger?: boolean;
  /** full-width content under the row (webhook URLs, an inline form) */
  extra?: React.ReactNode;
  /** DOM id; defaults to one derived from a plain-text label */
  id?: string;
}) {
  const generated = useId();
  const controlId = typeof control === "function" ? (htmlFor ?? generated) : htmlFor;
  const domId = id ?? (typeof label === "string" ? rowId(label) : undefined);
  return (
    <div className={`${styles.row} ${danger ? styles.danger : ""}`} id={domId}>
      <div className={styles.rowText}>
        {controlId === undefined ? (
          <span className={styles.rowLabel}>{label}</span>
        ) : (
          <label className={styles.rowLabel} htmlFor={controlId}>
            {label}
          </label>
        )}
        {help === undefined ? null : <span className={styles.rowHelp}>{help}</span>}
      </div>
      {control === undefined ? null : (
        <div className={styles.rowControl}>{typeof control === "function" ? control(controlId ?? generated) : control}</div>
      )}
      {extra === undefined ? null : <div className={styles.rowExtra}>{extra}</div>}
    </div>
  );
}
