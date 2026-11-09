import { createContext, useContext, type ReactNode } from "react";
import styles from "./settings.module.css";

/** SettingsView offers the machine picker through this, so sections need not pass it down. */
export const MachineSlotContext = createContext<ReactNode>(null);

/** One settings section: a title, a one-line blurb, then its groups. Capped at `--measure`. */
export function SettingsPage({
  title,
  blurb,
  machine,
  children,
}: {
  title: string;
  blurb: ReactNode;
  /** the "Settings of <machine>" picker; defaults to the one SettingsView provides */
  machine?: ReactNode;
  children: ReactNode;
}) {
  const inherited = useContext(MachineSlotContext);
  const picker = machine ?? inherited;
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>{title}</h2>
        <p className={styles.blurb}>{blurb}</p>
        {picker}
      </header>
      {children}
    </div>
  );
}
