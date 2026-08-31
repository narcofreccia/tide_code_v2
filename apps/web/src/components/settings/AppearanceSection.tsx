import { DENSITIES, THEMES, useSettings, type Density, type Theme } from "../../state/settings.ts";
import { Select } from "../ui/Select.tsx";
import section from "./Section.module.css";

const THEME_LABELS: Record<Theme, string> = { system: "System", dark: "Dark", light: "Light" };
const DENSITY_LABELS: Record<Density, string> = { comfortable: "Comfortable", compact: "Compact" };

/** Writes `data-theme` / `data-density` on `<html>`; `styles/tokens.css` does the rest. */
export function AppearanceSection() {
  const theme = useSettings((s) => s.theme);
  const density = useSettings((s) => s.density);
  const setTheme = useSettings((s) => s.setTheme);
  const setDensity = useSettings((s) => s.setDensity);

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
    </div>
  );
}
