import type { UserSettings } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";
import { useTrackSave } from "./ui/saved.ts";
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

function Range({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => Promise<void> }) {
  const track = useTrackSave();
  return (
    <span className={css.range}>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={STEP}
        value={value}
        aria-label={label}
        onChange={(e) => track(() => onChange(round(Number(e.target.value))))}
      />
      <span className={css.num}>{value.toFixed(2)}</span>
    </span>
  );
}

/** Gray-zone thresholds, per-site switches and the experts auto-advance opt-in. */
export function DecisionsTuning() {
  const { grayZone, sites, expertsAutoAdvance } = useServerSettings((s) => s.settings.decisions);
  const { low, high } = grayZone;

  const setLow = (value: number): Promise<void> => {
    const next = Math.min(value, 1 - STEP);
    return patchServerSettings({ decisions: { grayZone: { low: next, high: Math.max(high, round(next + STEP)) } } });
  };
  const setHigh = (value: number): Promise<void> => {
    const next = Math.max(value, STEP);
    return patchServerSettings({ decisions: { grayZone: { high: next, low: Math.min(low, round(next - STEP)) } } });
  };

  return (
    <>
      <SettingsGroup title="Gray zone">
        <SettingRow label="Gray zone low" htmlFor="jev-low" control={<Range id="jev-low" label="Gray zone low" value={low} onChange={setLow} />} />
        <SettingRow label="Gray zone high" htmlFor="jev-high" control={<Range id="jev-high" label="Gray zone high" value={high} onChange={setHigh} />} />
        <SettingNote>
          Below {low.toFixed(2)}: nothing is shown or acted on. Between: shown, fallback asked. At or above {high.toFixed(2)}:
          Jev&apos;s answer stands.
        </SettingNote>
      </SettingsGroup>
      <SettingsGroup title="Where Tide asks">
        {SITES.map((site) => (
          <SettingRow
            key={site.key}
            label={site.label}
            help={site.caption}
            control={(id) => (
              <SettingToggle
                id={id}
                checked={sites[site.key]}
                onChange={(on) => patchServerSettings({ decisions: { sites: { [site.key]: on } } })}
              />
            )}
          />
        ))}
        <SettingRow
          label="Advance experts automatically when converged"
          help="Off by default. Otherwise Tide only shows that the panel converged."
          control={(id) => (
            <SettingToggle
              id={id}
              checked={expertsAutoAdvance}
              onChange={(on) => patchServerSettings({ decisions: { expertsAutoAdvance: on } })}
            />
          )}
        />
      </SettingsGroup>
    </>
  );
}
