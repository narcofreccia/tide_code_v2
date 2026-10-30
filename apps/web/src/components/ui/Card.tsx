import styles from "./Card.module.css";

/**
 * A flat content card: `--surface`, hairline border, `--radius-lg`. `header` draws a title row
 * (with optional `actions` on the right) above a hairline. Never nest one card in another.
 */
export function Card({
  header,
  actions,
  children,
  label,
  className,
}: {
  header?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** accessible name; makes the card a labelled region */
  label?: string;
  className?: string;
}) {
  return (
    <section
      className={[styles.card, className].filter(Boolean).join(" ")}
      {...(label === undefined ? {} : { "aria-label": label })}
    >
      {header === undefined && actions === undefined ? null : (
        <div className={styles.head}>
          <h3 className={styles.title}>{header}</h3>
          {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {children === undefined ? null : <div className={styles.body}>{children}</div>}
    </section>
  );
}
