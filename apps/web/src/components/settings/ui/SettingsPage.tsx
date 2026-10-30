import styles from "./settings.module.css";

/** One settings section: a title, a one-line blurb, then its groups. Capped at `--measure`. */
export function SettingsPage({ title, blurb, children }: { title: string; blurb: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>{title}</h2>
        <p className={styles.blurb}>{blurb}</p>
      </header>
      {children}
    </div>
  );
}
