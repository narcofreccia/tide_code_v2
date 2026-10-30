import { environmentName, useEnvironments } from "../../state/environments.ts";
import { useUi } from "../../state/ui.ts";
import { EnvDot, HostBars } from "./FleetBits.tsx";
import { connectionLabel, statusOf } from "./envView.ts";
import styles from "./MachinesStrip.module.css";

/**
 * Mission Control's "Machines" line: one chip per known environment with its state and load.
 * Hidden until at least one environment is known; a chip opens Settings › Environments.
 */
export function MachinesStrip() {
  const state = useEnvironments();
  const showSettings = useUi((s) => s.showSettings);
  const setSettingsSection = useUi((s) => s.setSettingsSection);
  if (state.environments.length === 0) return null;
  const open = (): void => {
    setSettingsSection("environments");
    showSettings();
  };
  const ordered = [...state.environments].sort((a, b) => Number(b.id === state.primaryId) - Number(a.id === state.primaryId));
  return (
    <section className={styles.strip} aria-label="Machines">
      <h2 className={styles.label}>Machines</h2>
      <ul className={styles.chips}>
        {ordered.map((env) => {
          const status = statusOf(state, env.id);
          const name = environmentName(env.id);
          const host = status.connection === "connected" ? status.info?.host : undefined;
          return (
            <li key={env.id}>
              <button
                type="button"
                className={styles.chip}
                aria-label={`${name}: ${connectionLabel(status)}`}
                title={`${name} — ${connectionLabel(status)}. Open Settings › Environments`}
                onClick={open}
              >
                <EnvDot connection={status.connection} />
                <span className={styles.name}>{name}</span>
                {host ? <HostBars host={host} /> : <span className={styles.hint}>{status.connection}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
