import { useTrackSave, type ChangeResult } from "./saved.ts";
import styles from "./settings.module.css";

/**
 * A switch: a real checkbox (so labels, forms and `.checked` keep working) exposed as
 * `role="switch"`, drawn as a 32×18 track. Space toggles natively; Enter toggles too.
 */
export function SettingToggle({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => ChangeResult;
  disabled?: boolean;
  /** accessible name when no `<label for>` names it */
  label?: string;
}) {
  const track = useTrackSave();
  const change = (next: boolean): void => track(() => onChange(next));
  return (
    <span className={styles.switch}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={styles.switchInput}
        checked={checked}
        disabled={disabled}
        onChange={(e) => change(e.target.checked)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || disabled) return;
          e.preventDefault();
          change(!checked);
        }}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </span>
  );
}
