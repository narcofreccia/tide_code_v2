import styles from "./Select.module.css";

export interface SelectOption<T extends string> {
  value: T;
  label?: string;
  disabled?: boolean;
  /** tooltip, used for the "not installed / not logged in" hint */
  title?: string;
}

function normalize<T extends string>(option: T | SelectOption<T>): SelectOption<T> {
  return typeof option === "string" ? { value: option } : option;
}

export function Select<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: readonly (T | SelectOption<T>)[];
  onSelect: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      className={[styles.select, className].filter(Boolean).join(" ")}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onSelect(e.target.value as T)}
    >
      {options.map(normalize).map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          title={option.title}
        >
          {option.label ?? option.value}
        </option>
      ))}
    </select>
  );
}
