import { Select, type SelectOption } from "../../ui/Select.tsx";
import { useTrackSave, type ChangeResult } from "./saved.ts";

/** `ui/Select` as a settings field (28px, `md`); a promise from `onSelect` flashes "Saved". */
export function SettingSelect<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled,
  align,
  searchable,
}: {
  label: string;
  value: T;
  options: readonly (T | SelectOption<T>)[];
  onSelect: (value: T) => ChangeResult;
  disabled?: boolean | undefined;
  align?: "start" | "end";
  searchable?: boolean;
}) {
  const track = useTrackSave();
  return (
    <Select
      label={label}
      value={value}
      options={options}
      onSelect={(next) => track(() => onSelect(next))}
      disabled={disabled}
      variant="field"
      size="md"
      align={align}
      searchable={searchable}
    />
  );
}
