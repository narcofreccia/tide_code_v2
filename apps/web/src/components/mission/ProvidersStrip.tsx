import { useState } from "react";
import { selectProviderRateLimits } from "@tide/client";
import type { ProviderStatusDto } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { RateLimitBadge } from "../ui/RateLimitBadge.tsx";
import { PROVIDERS, PROVIDER_LABELS } from "../../lib/vocab.ts";
import { providerStatus, useProviderRoster } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { resolveLoginCommand, runOrCopy } from "../../lib/providerLogin.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./MissionControl.module.css";

/** `✓ ready · ⚠ not logged in · ✕ not installed` — the whole harness roster in one line. */
export function providerChipState(
  status: ProviderStatusDto | undefined,
  loading = false,
): { glyph: string; text: string; tone: string } {
  if (loading) return { glyph: "·", text: "checking…", tone: "off" };
  if (!status || !status.installed) return { glyph: "✕", text: "not installed", tone: "off" };
  if (!status.loggedIn) return { glyph: "⚠", text: "not logged in", tone: "warn" };
  return { glyph: "✓", text: "ready", tone: "ok" };
}

/** "4 agents ready · 1 needs login · 1 not installed"; only the non-zero parts. */
export function rosterSummary(providers: ProviderStatusDto[], loading: boolean): string {
  if (loading) return "Checking agents…";
  const states = PROVIDERS.map((kind) => providerStatus(providers, kind));
  const ready = states.filter((s) => s?.installed === true && s.loggedIn).length;
  const needsLogin = states.filter((s) => s?.installed === true && !s.loggedIn).length;
  const missing = states.length - ready - needsLogin;
  const parts = [`${ready} ${ready === 1 ? "agent" : "agents"} ready`];
  if (needsLogin > 0) parts.push(`${needsLogin} needs login`);
  if (missing > 0) parts.push(`${missing} not installed`);
  return parts.join(" · ");
}

/**
 * The four harnesses Tide drives, folded to one summary line; opened, each shows its
 * rate-limit state when a thread reported one that is not ok. A chip opens Settings › Providers; a harness
 * that is installed but logged out offers to run its own login command in the
 * selected thread's terminal (and copies it when there is no thread).
 */
export function ProvidersStrip() {
  const { providers, loading } = useProviderRoster();
  // the subscription is shared: the worst status across that harness's threads
  const limits = selectProviderRateLimits(useModel((s) => s.model));
  const [expanded, setExpanded] = useState(false);
  const showSettings = useUi((s) => s.showSettings);
  const setSettingsSection = useUi((s) => s.setSettingsSection);

  const open = (): void => {
    setSettingsSection("providers");
    showSettings();
  };

  return (
    <section className={styles.section} aria-label="Providers">
      <h2 className={styles.label}>
        <button type="button" className={styles.fold} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "▾" : "▸"} Harnesses
          <span className={styles.foldSummary}>{rosterSummary(providers, loading)}</span>
        </button>
      </h2>
      {expanded ? (
        <ul className={styles.chips}>
          {PROVIDERS.map((kind) => {
            const status = providerStatus(providers, kind);
            const { glyph, text, tone } = providerChipState(status, loading);
            const command = loading ? undefined : resolveLoginCommand(status);
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
                <RateLimitBadge limit={limits[kind]} />
                {command ? (
                  <Button variant="quiet" onClick={() => void runOrCopy(command)}>
                    Run {command}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
