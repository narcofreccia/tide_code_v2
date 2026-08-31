import type { ProviderStatusDto } from "@tide/contracts";
import { PROVIDERS, PROVIDER_LABELS } from "../../lib/vocab.ts";
import { providerStatus, useProviders } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { loginCommand, runOrCopy } from "../settings/ProviderCard.tsx";
import { Button } from "../ui/Button.tsx";
import styles from "./MissionControl.module.css";

/** `✓ ready · ⚠ not logged in · ✕ not installed` — the whole harness roster in one line. */
export function providerChipState(status: ProviderStatusDto | undefined): {
  glyph: string;
  text: string;
  tone: string;
} {
  if (!status || !status.installed) return { glyph: "✕", text: "not installed", tone: "off" };
  if (!status.loggedIn) return { glyph: "⚠", text: "not logged in", tone: "warn" };
  return { glyph: "✓", text: "ready", tone: "ok" };
}

/**
 * The four harnesses Tide drives. A chip opens Settings › Providers; a harness
 * that is installed but logged out offers to run its own login command in the
 * selected thread's terminal (and copies it when there is no thread).
 */
export function ProvidersStrip() {
  const providers = useProviders();
  const showSettings = useUi((s) => s.showSettings);
  const setSettingsSection = useUi((s) => s.setSettingsSection);

  const open = (): void => {
    setSettingsSection("providers");
    showSettings();
  };

  return (
    <section className={styles.section} aria-label="Providers">
      <h2 className={styles.label}>Providers</h2>
      <ul className={styles.chips}>
        {PROVIDERS.map((kind) => {
          const status = providerStatus(providers, kind);
          const { glyph, text, tone } = providerChipState(status);
          const command = status?.loginCommand ?? loginCommand(status?.hint);
          return (
            <li key={kind} className={styles.chip}>
              <button
                type="button"
                className={styles.chipMain}
                onClick={open}
                aria-label={`${PROVIDER_LABELS[kind]}: ${text}`}
                title={`${PROVIDER_LABELS[kind]} — ${text}. Open Settings › Providers`}
              >
                <span className={`${styles.chipGlyph} ${styles[tone] ?? ""}`} aria-hidden="true">
                  {glyph}
                </span>
                <span>{PROVIDER_LABELS[kind]}</span>
                <span className={styles.chipHint}>{text}</span>
              </button>
              {status?.installed === true && status.loggedIn === false && command ? (
                <Button variant="quiet" onClick={() => void runOrCopy(command)}>
                  Run {command}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
