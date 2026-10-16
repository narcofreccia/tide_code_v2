import type { UserSettings } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Checkbox } from "../ui/Choice.tsx";
import css from "./Decisions.module.css";

type Sites = UserSettings["decisions"]["sites"];
const STEP = 0.05;

const SITES: { key: keyof Sites; label: string; caption: string }[] = [
  { key: "handoff", label: "Handoff", caption: "Rank which earlier turns a new harness needs." },
  { key: "delegates", label: "Delegates", caption: "Label how a delegated task ended." },
  { key: "approvals", label: "Approvals", caption: "Mark approvals routine or consequential; auto-allow is per thread." },
  { key: "experts", label: "Experts", caption: "Say when the panel has converged." },
  { key: "stuck", label: "Stuck", caption: "Flag a running thread that stopped making progress." },
];

const round = (n: number): number => Math.round(n * 100) / 100;

/** Gray-zone thresholds, per-site switches and the experts auto-advance opt-in. */
export function DecisionsTuning() {
  const { grayZone, sites, expertsAutoAdvance } = useServerSettings((s) => s.settings.decisions);
  const { low, high } = grayZone;

  const setLow = (value: number): void => {
    const next = Math.min(value, 1 - STEP);
    void patchServerSettings({ decisions: { grayZone: { low: next, high: Math.max(high, round(next + STEP)) } } });
  };
  const setHigh = (value: number): void => {
    const next = Math.max(value, STEP);
    void patchServerSettings({ decisions: { grayZone: { high: next, low: Math.min(low, round(next - STEP)) } } });
  };

  return (
    <div className={css.card}>
      <h4 className={css.cardTitle}>Tuning</h4>
      <div className={css.field}>
        <div className={css.range}>
          <label htmlFor="jev-low">Low</label>
          <input id="jev-low" type="range" min={0} max={1} step={STEP} value={low}
            aria-label="Gray zone low" onChange={(e) => setLow(round(Number(e.target.value)))} />
          <span className={css.num}>{low.toFixed(2)}</span>
        </div>
        <div className={css.range}>
          <label htmlFor="jev-high">High</label>
          <input id="jev-high" type="range" min={0} max={1} step={STEP} value={high}
            aria-label="Gray zone high" onChange={(e) => setHigh(round(Number(e.target.value)))} />
          <span className={css.num}>{high.toFixed(2)}</span>
        </div>
        <p className={css.note}>
          Below {low.toFixed(2)}: nothing is shown or acted on. Between: shown, fallback asked. At or above{" "}
          {high.toFixed(2)}: Jev&apos;s answer stands.
        </p>
      </div>
      {SITES.map((site) => (
        <div key={site.key} className={css.site}>
          <Checkbox
            checked={sites[site.key]}
            onChange={(e) => void patchServerSettings({ decisions: { sites: { [site.key]: e.target.checked } } })}
          >
            {site.label}
          </Checkbox>
          <p className={css.caption}>{site.caption}</p>
        </div>
      ))}
      <div className={css.site}>
        <Checkbox
          checked={expertsAutoAdvance}
          onChange={(e) => void patchServerSettings({ decisions: { expertsAutoAdvance: e.target.checked } })}
        >
          Advance experts automatically when converged
        </Checkbox>
        <p className={css.caption}>Off by default. Otherwise Tide only shows that the panel converged.</p>
      </div>
    </div>
  );
}
