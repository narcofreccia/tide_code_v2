import styles from "./StageList.module.css";

/**
 * The ordered member list of a composition dialog. `flow="sequence"` joins the
 * gutters with a hairline (team stages run in order); `parallel` leaves them
 * apart (experts work side by side). The trailing ghost card is the add action.
 */
export function StageList({
  label,
  flow = "sequence",
  add,
  children,
}: {
  label: string;
  flow?: "sequence" | "parallel";
  add?: { label: string; onClick: () => void; disabled?: boolean; hint?: string; glyph?: string } | undefined;
  children: React.ReactNode;
}) {
  return (
    <ol className={`${styles.list} ${flow === "sequence" ? styles.sequence : ""}`} aria-label={label}>
      {children}
      {add === undefined ? null : (
        <li className={styles.ghostItem}>
          <button
            type="button"
            className={styles.ghost}
            aria-label={add.label}
            disabled={add.disabled}
            onClick={add.onClick}
          >
            <span className={styles.ghostGlyph} aria-hidden="true">
              {add.glyph ?? "+"}
            </span>
            <span className={styles.ghostLabel}>{add.label}</span>
            {add.hint === undefined ? null : <span className={styles.ghostHint}>{add.hint}</span>}
          </button>
        </li>
      )}
    </ol>
  );
}
