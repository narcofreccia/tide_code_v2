import { useEffect, useState } from "react";
import type { UsageSummary } from "@tide/contracts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { callTargets, useMultiEnv } from "../../lib/envTargets.ts";
import { environmentName } from "../../state/environments.ts";
import { call } from "../../state/model.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Checkbox } from "../ui/Choice.tsx";
import { DayBars } from "./DayBars.tsx";
import { LimitsPanel } from "./LimitsPanel.tsx";
import { UsageSummaryCards, UsageTable } from "./UsageTable.tsx";
import { windowRange, type EnvUsage, type UsageWindow } from "./usageMath.ts";
import styles from "./Usage.module.css";

const WINDOWS: { value: UsageWindow; label: string }[] = [
  { value: 7, label: "7 d" },
  { value: 30, label: "30 d" },
  { value: 90, label: "90 d" },
  { value: "custom", label: "Custom" },
];

function isoDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `usage.summary` on every connected environment for the window. */
function useUsage(since: number, until: number, includeExternal: boolean): { results: EnvUsage[]; loading: boolean } {
  const [results, setResults] = useState<EnvUsage[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = { since, until, includeExternal };
    Promise.all(
      callTargets().map(async (envId): Promise<EnvUsage> => {
        try {
          const summary: UsageSummary = await (envId === undefined ? call("usage.summary", params) : call("usage.summary", params, { envId }));
          return { ...(envId === undefined ? {} : { envId }), summary };
        } catch (error) {
          return { ...(envId === undefined ? {} : { envId }), error: errorText(error) };
        }
      }),
    ).then((next) => {
      if (!alive) return;
      setResults(next);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [since, until, includeExternal]);
  return { results, loading };
}

function EnvSection({ usage, titled }: { usage: EnvUsage; titled: boolean }) {
  const providers = useProvidersSnapshot();
  const summary = usage.summary;
  return (
    <section className={styles.envSection} aria-label={titled ? `Usage on ${environmentName(usage.envId)}` : "Usage"}>
      {titled ? <h3 className={styles.sectionTitle}>{environmentName(usage.envId)}</h3> : null}
      {usage.error ? (
        <p className={styles.error} role="alert">
          Usage unavailable: {usage.error}
        </p>
      ) : null}
      {summary ? (
        <>
          {summary.rows.length > 0 ? <UsageSummaryCards rows={summary.rows} /> : null}
          <DayBars days={summary.days} />
          <UsageTable rows={summary.rows} providers={providers} />
          <p className={styles.legend}>
            Reported = what the harness said it cost. Estimated = Tide's price table {summary.pricingVersion}, not your bill.
          </p>
          {summary.notes.length > 0 ? (
            <ul className={styles.notes} aria-label="Notes">
              {summary.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * The usage glass box: tokens and money by harness and model over a window, Tide's own
 * turns and (opt-in) what the harnesses' logs show, plus every harness's current limits.
 */
export function UsageView() {
  const readLogs = useServerSettings((s) => s.settings.glassBox.readHarnessLogs);
  const [range, setRange] = useState<UsageWindow>(30);
  const [now] = useState(() => Date.now());
  const [custom, setCustom] = useState(() => ({ from: isoDay(now - 7 * 86_400_000), to: isoDay(now) }));
  const { since, until } = windowRange(range, now, custom);
  const { results, loading } = useUsage(since, until, readLogs);
  const multi = useMultiEnv() && results.length > 1;

  return (
    <section className={styles.view} aria-label="Usage page">
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>Usage</h2>
        <p className={styles.blurb}>Tokens and spend by harness and model, and each harness's current limits.</p>
      </header>
      <div className={styles.head} role="toolbar" aria-label="Usage window">
        <div className={styles.windowPicker} role="radiogroup" aria-label="Window">
          {WINDOWS.map((w) => (
            <button
              key={String(w.value)}
              type="button"
              role="radio"
              aria-checked={range === w.value}
              className={`${styles.chip} ${range === w.value ? styles.chipOn : ""}`}
              onClick={() => setRange(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
        {range === "custom" ? (
          <span className={styles.custom}>
            <input type="date" aria-label="From" className={styles.date} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            –
            <input type="date" aria-label="To" className={styles.date} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </span>
        ) : null}
        <span className={styles.toggle}>
          <Checkbox checked={readLogs} onChange={(e) => void patchServerSettings({ glassBox: { readHarnessLogs: e.target.checked } })}>
            Read harness logs
          </Checkbox>
        </span>
      </div>
      {loading && results.length === 0 ? <p className={styles.note}>Loading usage…</p> : null}
      {results.map((usage) => (
        <EnvSection key={usage.envId ?? "local"} usage={usage} titled={multi} />
      ))}
      <LimitsPanel />
    </section>
  );
}
