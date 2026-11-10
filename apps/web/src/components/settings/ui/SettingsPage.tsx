import { createContext, useContext, type ReactNode } from "react";
import { Button } from "../../ui/Button.tsx";
import styles from "./settings.module.css";

/** SettingsView offers the machine picker through this, so sections need not pass it down. */
export const MachineSlotContext = createContext<ReactNode>(null);

/**
 * Whether the server settings this page edits have answered. SettingsView sets it for the
 * server-backed sections; client-only ones (appearance, notifications) stay `ready` always.
 */
export type SettingsGate = { status: "ready" } | { status: "loading" } | { status: "error"; message: string; retry: () => void };

export const SettingsGateContext = createContext<SettingsGate>({ status: "ready" });

function GateLine({ gate }: { gate: Exclude<SettingsGate, { status: "ready" }> }) {
  if (gate.status === "loading") {
    return (
      <p className={styles.gateLine} role="status">
        Loading settings…
      </p>
    );
  }
  return (
    <p className={`${styles.gateLine} ${styles.gateError}`} role="alert">
      <span>Couldn’t load these settings: {gate.message}</span>
      <Button variant="ghost" onClick={gate.retry}>
        Retry
      </Button>
    </p>
  );
}

/**
 * One settings section: a title, a one-line blurb, then its groups. Capped at `--measure`.
 * Until the server's settings load the groups are dimmed and inert: what they would show
 * are client defaults, and a change made then could overwrite the server's lists.
 */
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
  const gate = useContext(SettingsGateContext);
  const picker = machine ?? inherited;
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>{title}</h2>
        <p className={styles.blurb}>{blurb}</p>
        {picker}
      </header>
      {gate.status === "ready" ? (
        children
      ) : (
        <>
          <GateLine gate={gate} />
          <div className={styles.gated} inert aria-busy={gate.status === "loading"} data-testid="settings-gated">
            {children}
          </div>
        </>
      )}
    </div>
  );
}
