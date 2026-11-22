import { useEffect, useState } from "react";
import type { UsageRepairResult, UsageSummary } from "@tide/contracts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { callTargets, useMultiEnv } from "../../lib/envTargets.ts";
import { formatUsd } from "../../lib/glassBox.ts";
import { environmentName } from "../../state/environments.ts";
import { call } from "../../state/model.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { DayBars } from "./DayBars.tsx";
import { LimitsPanel } from "./LimitsPanel.tsx";
import { UsageSummaryCards, UsageTable } from "./UsageTable.tsx";
import { filterRowsBySource, windowRange, type EnvUsage, type SourceFilter, type UsageWindow } from "./usageMath.ts";
import styles from "./Usage.module.css";

const WINDOWS: { value: UsageWindow; label: string }[] = [
  { value: 7, label: "7 d" },
  { value: 30, label: "30 d" },
  { value: 90, label: "90 d" },
  { value: "custom", label: "Custom" },
];

const SOURCES: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "tide", label: "Tide" },
  { value: "external", label: "Logs" },
];

function isoDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `usage.summary` on every connected environment for the window. */
function useUsage(since: number, until: number, includeExternal: boolean, refreshKey: number): { results: EnvUsage[]; loading: boolean } {
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
  }, [since, until, includeExternal, refreshKey]);
  return { results, loading };
}

/**
 * Checks `usage.repair` (dry run) and surfaces a one-click banner when pre-R20 resumed Claude
 * sessions left inflated cumulative `total_cost_usd` reports in the event log.
 */
function RepairBanner({ envId, onRepaired }: { envId: string | undefined; onRepaired: () => void }) {
  const [plan, setPlan] = useState<UsageRepairResult | undefined>(undefined);
  const [includeHeuristic, setIncludeHeuristic] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const req = envId === undefined ? call("usage.repair", {}) : call("usage.repair", {}, { envId });
    req
      .then((res) => {
        if (!alive || !res) return;
        setPlan(res);
        const pending = res.rows.filter((r) => !r.applied);
        const hasTranscript = pending.some((r) => r.evidence === "transcript");
        setIncludeHeuristic(!hasTranscript && pending.length > 0);
      })
      .catch(() => {
        // Older servers or limited devices cannot run usage.repair: stay quiet.
      });
    return () => {
      alive = false;
    };
  }, [envId]);

  const pending = plan?.rows.filter((r) => !r.applied) ?? [];
  if (pending.length === 0) return null;

  const heuristicCount = pending.filter((r) => r.evidence === "heuristic").length;
  const eligible = pending.filter((r) => includeHeuristic || r.evidence === "transcript");
  const storedUsd = eligible.reduce((sum, r) => sum + r.storedUsd, 0);
  const correctedUsd = eligible.reduce((sum, r) => sum + r.correctedUsd, 0);

  const apply = async (): Promise<void> => {
    setApplying(true);
    setError(undefined);
    try {
      const params = { apply: true, ...(includeHeuristic ? { includeHeuristic: true } : {}) };
      const res = await (envId === undefined ? call("usage.repair", params) : call("usage.repair", params, { envId }));
      setPlan(res);
      onRepaired();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className={styles.repairBanner} role="status" aria-label="Claude cost repair">
      <div className={styles.repairCopy}>
        <strong>Inflated Claude costs detected</strong>
        <span>
          {eligible.length} resumed Claude {eligible.length === 1 ? "report" : "reports"} stored {formatUsd(storedUsd)} instead of{" "}
          {formatUsd(correctedUsd)} (cumulative session cost counted per turn).
        </span>
        {error ? <span className={styles.error}>{error}</span> : null}
      </div>
      <div className={styles.repairActions}>
        {heuristicCount > 0 ? (
          <Checkbox checked={includeHeuristic} onChange={(e) => setIncludeHeuristic(e.target.checked)}>
            Include {heuristicCount} without transcript
          </Checkbox>
        ) : null}
        <Button variant="primary" disabled={applying || eligible.length === 0} onClick={() => void apply()}>
          {applying ? "Repairing…" : "Repair costs"}
        </Button>
      </div>
    </div>
  );
}

/** Structural placeholder matching the KPI strip, daily chart and table heights to prevent layout shift. */
function UsageSkeleton() {
  return (
    <div className={styles.skeletonWrap} role="status" aria-busy="true" aria-label="Loading usage">
      <div className={styles.summary}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={styles.stat}>
            <span className={`${styles.skelBar} ${styles.skelSm}`} />
            <span className={`${styles.skelBar} ${styles.skelLg}`} />
          </div>
        ))}
      </div>
      <div className={styles.skelChart}>
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i} className={`${styles.skelCol} ${styles[`sh${(i % 5) + 1}`] ?? ""}`} />
        ))}
      </div>
      <div className={styles.card}>
        <div className={styles.skelTable}>
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={`${styles.skelBar} ${styles.skelRow}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function EnvSection({
  usage,
  titled,
  source,
  onRepaired,
}: {
  usage: EnvUsage;
  titled: boolean;
  source: SourceFilter;
  onRepaired: () => void;
}) {
  const providers = useProvidersSnapshot();
  const summary = usage.summary;
  const rows = summary ? filterRowsBySource(summary.rows, source) : [];
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
          <RepairBanner envId={usage.envId} onRepaired={onRepaired} />
          {rows.length > 0 ? <UsageSummaryCards rows={rows} /> : null}
          <DayBars days={summary.days} {...(source !== "all" ? { sourceNote: "all sources" } : {})} />
          <UsageTable rows={rows} providers={providers} />
          <div className={styles.footnote}>
            <p className={styles.legend}>
              Reported = what the harness said it cost. Estimated = Tide's price table {summary.pricingVersion}, not your bill.
            </p>
            {summary.notes.length > 0 ? (
              <details className={styles.notesDisclosure}>
                <summary className={styles.notesSummary}>
                  Details &amp; scan notes ({summary.notes.length})
                </summary>
                <ul className={styles.notes} aria-label="Notes">
                  {summary.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * The usage glass box: live harness limits at the top (zero latency, zero jump), followed by
 * tokens and money by harness and model over a window (Tide's own turns + opt-in harness logs).
 */
export function UsageView() {
  const readLogs = useServerSettings((s) => s.settings.glassBox.readHarnessLogs);
  const [range, setRange] = useState<UsageWindow>(30);
  const [source, setSource] = useState<SourceFilter>("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [now] = useState(() => Date.now());
  const [custom, setCustom] = useState(() => ({ from: isoDay(now - 7 * 86_400_000), to: isoDay(now) }));
  const { since, until } = windowRange(range, now, custom);
  const { results, loading } = useUsage(since, until, readLogs, refreshKey);
  const multi = useMultiEnv() && results.length > 1;
  const activeSource: SourceFilter = readLogs ? source : "all";

  return (
    <section className={styles.view} aria-label="Usage page">
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>Usage</h2>
        <p className={styles.blurb}>Current harness limits, plus tokens and spend by harness and model.</p>
      </header>

      <LimitsPanel />

      <div className={styles.historyBlock}>
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
          {readLogs ? (
            <div className={styles.sourcePicker} role="radiogroup" aria-label="Source filter">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  role="radio"
                  aria-checked={activeSource === s.value}
                  className={`${styles.chip} ${activeSource === s.value ? styles.chipOn : ""}`}
                  onClick={() => setSource(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
          <span className={styles.toggle}>
            {loading && results.length > 0 ? <span className={styles.updatingBadge}>Updating…</span> : null}
            <Checkbox checked={readLogs} onChange={(e) => void patchServerSettings({ glassBox: { readHarnessLogs: e.target.checked } })}>
              Read harness logs
            </Checkbox>
          </span>
        </div>

        {loading && results.length === 0 ? (
          <UsageSkeleton />
        ) : (
          <div className={`${styles.results} ${loading ? styles.updating : ""}`} aria-busy={loading}>
            {results.map((usage) => (
              <EnvSection
                key={usage.envId ?? "local"}
                usage={usage}
                titled={multi}
                source={activeSource}
                onRepaired={() => setRefreshKey((k) => k + 1)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
