import { useRef, useState } from "react";
import { DENSITIES, THEMES, useSettings, type Density, type Theme } from "../../state/settings.ts";
import { FONT_SIZES, readBaseTokens, type FontSize } from "../../lib/theme.ts";
import { importVscodeTheme, type ImportedTheme } from "../../lib/vscodeTheme.ts";
import { Button } from "../ui/Button.tsx";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingSelect } from "./ui/SettingSelect.tsx";
import { rowId } from "./ui/saved.ts";
import ui from "./ui/settings.module.css";
import styles from "./AppearanceSection.module.css";

const THEME_LABELS: Record<Theme, string> = { system: "System", dark: "Dark", light: "Light" };
const DENSITY_LABELS: Record<Density, string> = { comfortable: "Comfortable", compact: "Compact" };

const SWATCH_TOKENS = ["--bg", "--surface", "--surface-raised", "--border-strong", "--text", "--accent", "--ok", "--warn", "--danger"];
const CUSTOM = "__custom";
const SYSTEM = "";
const UI_STACKS: Array<{ value: string; label: string }> = [
  { value: SYSTEM, label: "System" },
  { value: 'Georgia, "Times New Roman", serif', label: "Serif" },
  { value: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: "Helvetica / Arial" },
  { value: 'system-ui, sans-serif', label: "system-ui" },
  { value: CUSTOM, label: "Custom…" },
];
const MONO_STACKS: Array<{ value: string; label: string }> = [
  { value: SYSTEM, label: "System mono" },
  { value: 'Menlo, Monaco, "Courier New", monospace', label: "Menlo / Monaco" },
  { value: 'Consolas, "Lucida Console", monospace', label: "Consolas" },
  { value: '"SF Mono", ui-monospace, monospace', label: "SF Mono" },
  { value: CUSTOM, label: "Custom…" },
];

export const META: SectionMeta = {
  title: "Appearance",
  blurb: "Colours and fonts apply to this device only.",
  keywords: ["Theme", "Density", "VS Code colour theme", "UI font", "Mono font", "Base size", "dark", "light"],
};

/** A family picker: a short list of safe stacks plus a free-text "Custom…". */
function FamilyRow({
  label,
  value,
  stacks,
  onChange,
}: {
  label: string;
  value: string | undefined;
  stacks: Array<{ value: string; label: string }>;
  onChange: (family: string | undefined) => void;
}) {
  const known = stacks.some((s) => s.value === (value ?? SYSTEM) && s.value !== CUSTOM);
  const [custom, setCustom] = useState(!known);
  const selected = custom ? CUSTOM : (value ?? SYSTEM);
  return (
    <SettingRow
      label={label}
      control={
        <>
          <SettingSelect
            label={label}
            value={selected}
            options={stacks}
            onSelect={(next) => {
              if (next === CUSTOM) return setCustom(true);
              setCustom(false);
              onChange(next === SYSTEM ? undefined : next);
            }}
          />
          {custom ? (
            <input
              className={`${ui.input} ${ui.wide}`}
              aria-label={`${label} custom family`}
              placeholder='e.g. "Fira Code", monospace'
              value={value ?? ""}
              onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
            />
          ) : null}
        </>
      }
    />
  );
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsText(file);
  });
}

function CustomTheme() {
  const customTheme = useSettings((s) => s.customTheme);
  const setCustomTheme = useSettings((s) => s.setCustomTheme);
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportedTheme | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (picked: File | undefined): Promise<void> => {
    if (!picked) return;
    try {
      const text = await readText(picked);
      setPreview(importVscodeTheme(text, readBaseTokens(), picked.name.replace(/\.[^.]+$/, "")));
      setError(null);
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : "Could not read the file");
    }
  };

  const shown = preview ?? (customTheme ? { scheme: customTheme.scheme ?? "dark", ...customTheme } : null);
  return (
    <SettingsGroup title="Custom theme" help="Import a VS Code colour theme; it replaces the palette on this device.">
      <SettingRow
        label={customTheme ? `Active: ${customTheme.name}` : "VS Code colour theme"}
        id={rowId("VS Code colour theme")}
        control={
          <>
            <input
              ref={file}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label="VS Code theme file"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button onClick={() => file.current?.click()}>Import VS Code theme JSON…</Button>
            {customTheme ? (
              <Button
                variant="quiet"
                onClick={() => {
                  setCustomTheme(undefined);
                  setPreview(null);
                }}
              >
                Clear
              </Button>
            ) : null}
          </>
        }
      />
      {shown ? (
        <SettingRow
          label={
            <svg className={styles.swatches} role="img" aria-label={`Preview of ${shown.name}`} viewBox="0 0 180 20" width="180" height="20">
              {SWATCH_TOKENS.map((t, i) => (
                <rect key={t} data-token={t} x={i * 20} y="0" width="18" height="18" rx="3" fill={shown.tokens[t] ?? "none"} />
              ))}
            </svg>
          }
          help={preview ? `${preview.name} · ${preview.scheme}` : undefined}
          control={
            preview ? (
              <>
                <Button
                  variant="primary"
                  onClick={() => {
                    setCustomTheme({ name: preview.name, scheme: preview.scheme, tokens: preview.tokens });
                    setPreview(null);
                  }}
                >
                  Apply
                </Button>
                <Button variant="quiet" onClick={() => setPreview(null)}>
                  Discard
                </Button>
              </>
            ) : undefined
          }
        />
      ) : null}
      {error ? <SettingNote role="alert">{error}</SettingNote> : null}
    </SettingsGroup>
  );
}

/** Writes `data-theme` / `data-density` on `<html>`; `styles/tokens.css` does the rest. */
export function AppearanceSection() {
  const theme = useSettings((s) => s.theme);
  const density = useSettings((s) => s.density);
  const fonts = useSettings((s) => s.fonts);
  const setTheme = useSettings((s) => s.setTheme);
  const setDensity = useSettings((s) => s.setDensity);
  const setFonts = useSettings((s) => s.setFonts);

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup title="Theme">
        <SettingRow
          label="Theme"
          help="System follows your OS colour scheme."
          control={
            <SettingSelect
              label="Theme"
              value={theme}
              options={THEMES.map((value) => ({ value, label: THEME_LABELS[value] }))}
              onSelect={setTheme}
            />
          }
        />
        <SettingRow
          label="Density"
          help="Switches list rows between 28px and 24px."
          control={
            <SettingSelect
              label="Density"
              value={density}
              options={DENSITIES.map((value) => ({ value, label: DENSITY_LABELS[value] }))}
              onSelect={setDensity}
            />
          }
        />
      </SettingsGroup>
      <CustomTheme />
      <SettingsGroup title="Fonts" help="Fonts must be installed locally.">
        <FamilyRow label="UI font" value={fonts.ui} stacks={UI_STACKS} onChange={(ui) => setFonts({ ui })} />
        <FamilyRow label="Mono font" value={fonts.mono} stacks={MONO_STACKS} onChange={(mono) => setFonts({ mono })} />
        <SettingRow
          label="Base size"
          control={
            <SettingSelect
              label="Base size"
              value={String(fonts.size)}
              options={FONT_SIZES.map((n) => ({ value: String(n), label: `${n}px` }))}
              onSelect={(n) => setFonts({ size: Number(n) as FontSize })}
            />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
