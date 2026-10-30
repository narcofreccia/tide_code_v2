import { useRef, useState } from "react";
import { DENSITIES, THEMES, useSettings, type Density, type Theme } from "../../state/settings.ts";
import { FONT_SIZES, readBaseTokens, type FontSize } from "../../lib/theme.ts";
import { importVscodeTheme, type ImportedTheme } from "../../lib/vscodeTheme.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import section from "./Section.module.css";
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
    <li className={`${section.row} ${styles.wrapRow}`}>
      <span className={section.label}>{label}</span>
      <span className={styles.controls}>
        <Select
          label={label}
          value={selected}
          options={stacks}
          onSelect={(next) => {
            if (next === CUSTOM) return setCustom(true);
            setCustom(false);
            onChange(next === SYSTEM ? undefined : next);
          }}
          variant="field"
          size="md"
        />
        {custom ? (
          <input
            className={section.input}
            aria-label={`${label} custom family`}
            placeholder='e.g. "Fira Code", monospace'
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          />
        ) : null}
      </span>
    </li>
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
    <>
      <div className={section.head}>
        <h3 className={section.title}>Custom theme</h3>
      </div>
      <ul className={section.rows}>
        <li className={`${section.row} ${styles.wrapRow}`}>
          <span className={section.label}>{customTheme ? `Active: ${customTheme.name}` : "VS Code colour theme"}</span>
          <span className={styles.controls}>
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
          </span>
        </li>
        {shown ? (
          <li className={`${section.row} ${styles.wrapRow}`}>
            <svg className={styles.swatches} role="img" aria-label={`Preview of ${shown.name}`} viewBox="0 0 180 20" width="180" height="20">
              {SWATCH_TOKENS.map((t, i) => (
                <rect key={t} data-token={t} x={i * 20} y="0" width="18" height="18" rx="3" fill={shown.tokens[t] ?? "none"} />
              ))}
            </svg>
            {preview ? (
              <span className={styles.controls}>
                <span className={section.label}>{preview.name} · {preview.scheme}</span>
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
              </span>
            ) : null}
          </li>
        ) : null}
      </ul>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </>
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
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Appearance</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Theme</span>
          <Select
            label="Theme"
            value={theme}
            options={THEMES.map((value) => ({ value, label: THEME_LABELS[value] }))}
            onSelect={setTheme}
            variant="field"
            size="md"
          />
        </li>
        <li className={section.row}>
          <span className={section.label}>Density</span>
          <Select
            label="Density"
            value={density}
            options={DENSITIES.map((value) => ({ value, label: DENSITY_LABELS[value] }))}
            onSelect={setDensity}
            variant="field"
            size="md"
          />
        </li>
      </ul>
      <p className={section.note}>
        System follows your OS colour scheme. Density switches list rows between 28px and 24px.
      </p>
      <CustomTheme />
      <div className={section.head}>
        <h3 className={section.title}>Fonts</h3>
      </div>
      <ul className={section.rows}>
        <FamilyRow label="UI font" value={fonts.ui} stacks={UI_STACKS} onChange={(ui) => setFonts({ ui })} />
        <FamilyRow label="Mono font" value={fonts.mono} stacks={MONO_STACKS} onChange={(mono) => setFonts({ mono })} />
        <li className={section.row}>
          <span className={section.label}>Base size</span>
          <Select
            label="Base size"
            value={String(fonts.size)}
            options={FONT_SIZES.map((n) => ({ value: String(n), label: `${n}px` }))}
            onSelect={(n) => setFonts({ size: Number(n) as FontSize })}
            variant="field"
            size="md"
          />
        </li>
      </ul>
      <p className={section.note}>Colours and fonts apply to this device only. Fonts must be installed locally.</p>
    </div>
  );
}
