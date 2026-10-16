import styles from "./StageList.module.css";

export interface PresetChip {
  key: string;
  label: string;
  pressed: boolean;
  /** tooltip: what picking it does */
  title?: string;
}

/** A row of toggle chips that fill a StageList (expert personas, saved teams). */
export function PresetChips({
  label,
  chips,
  onToggle,
  kind = "toggle",
}: {
  label: string;
  chips: PresetChip[];
  onToggle: (key: string) => void;
  /** `toggle`: each chip adds or removes itself; `pick`: exactly one is chosen */
  kind?: "toggle" | "pick";
}) {
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className={styles.chip}
          aria-pressed={chip.pressed}
          {...(chip.title === undefined ? {} : { title: chip.title })}
          onClick={() => onToggle(chip.key)}
        >
          <span className={styles.chipTick} aria-hidden="true">
            {chip.pressed ? "✓" : kind === "toggle" ? "+" : ""}
          </span>
          {chip.label}
        </button>
      ))}
    </div>
  );
}
