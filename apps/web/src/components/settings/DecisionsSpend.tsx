import { useEffect, useState } from "react";
import type { DecisionsStats } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import css from "./Decisions.module.css";

const POLL_MS = 30_000;
const usd = (n: number): string => `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Today's spend, per-site totals and the last verdicts; polls `decisions.stats`. */
export function DecisionsSpend() {
  const [stats, setStats] = useState<DecisionsStats | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    const load = (): void => {
      call("decisions.stats", {}).then((s) => { if (live) setStats(s); }, () => undefined);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const recent = stats?.recent.slice(0, 20) ?? [];
  const fallbackRows = recent.filter((r) => r.source === "fallback");
  const fallbackNa = fallbackRows.length > 0 && fallbackRows.every((r) => r.usd === undefined);
  const sites = Object.entries(stats?.bySite ?? {});
  const empty = stats === null || (stats.today.jev.calls === 0 && stats.today.fallback.calls === 0 && recent.length === 0);

  return (
    <div className={css.card}>
      <h4 className={css.cardTitle}>Spend</h4>
      {empty ? (
        <p className={css.note}>No verdicts yet.</p>
      ) : (
        <>
          <table className={css.stats} aria-label="Today">
            <thead>
              <tr><th>Today</th><th className={css.n}>Calls</th><th className={css.n}>Tokens</th><th className={css.n}>Cost</th></tr>
            </thead>
            <tbody>
              <tr><td>Jev</td><td className={css.n}>{stats.today.jev.calls}</td><td className={css.n}>{stats.today.jev.tokens}</td><td className={css.n}>{usd(stats.today.jev.usd)}</td></tr>
              <tr><td>Fallback</td><td className={css.n}>{stats.today.fallback.calls}</td><td className={css.n}>{stats.today.fallback.tokens}</td><td className={css.n}>{fallbackNa ? "n/a" : usd(stats.today.fallback.usd)}</td></tr>
            </tbody>
          </table>
          {sites.length > 0 ? (
            <table className={css.stats} aria-label="By site">
              <thead>
                <tr><th>Site</th><th className={css.n}>Calls</th><th className={css.n}>Tokens</th><th className={css.n}>Cost</th></tr>
              </thead>
              <tbody>
                {sites.map(([site, b]) => (
                  <tr key={site}><td>{site}</td><td className={css.n}>{b.calls}</td><td className={css.n}>{b.tokens}</td><td className={css.n}>{usd(b.usd)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <Button className={css.toggle} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide recent verdicts" : `Recent verdicts (${recent.length})`}
          </Button>
          {open ? (
            <table className={css.stats} aria-label="Recent verdicts">
              <thead>
                <tr><th>Time</th><th>Site</th><th>Verdict</th><th className={css.n}>Confidence</th><th>Source</th><th className={css.n}>Cost</th><th className={css.n}>ms</th></tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td>{time(r.at)}</td>
                    <td>{r.site}</td>
                    <td className={r.error ? css.error : undefined}>{r.error ?? r.label ?? "-"}</td>
                    <td className={css.n}>{r.confidence.toFixed(2)}</td>
                    <td>{r.source}</td>
                    <td className={css.n}>{r.usd === undefined ? "n/a" : usd(r.usd)}</td>
                    <td className={css.n}>{r.elapsedMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}
    </div>
  );
}
