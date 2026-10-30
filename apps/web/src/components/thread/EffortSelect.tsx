import type { Effort } from "../../state/providers.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";

/** "" = no explicit effort: the harness decides (its own default level). */
export const DEFAULT_EFFORT_LABEL = "Default";

export function effortOptions(efforts: readonly Effort[]): SelectOption<string>[] {
  const fallback = efforts.find((e) => e.default);
  return [
    {
      value: "",
      label: DEFAULT_EFFORT_LABEL,
      description: fallback ? `The harness default (${fallback.label})` : "The harness decides",
    },
    ...efforts.map((e) => ({ value: e.id, label: e.label })),
  ];
}

/** The reasoning-effort picker; only rendered when the model lists `efforts`. */
export function EffortSelect({
  label,
  efforts,
  value,
  onSelect,
  variant,
  className,
}: {
  label: string;
  efforts: readonly Effort[];
  value: string | undefined;
  onSelect: (effort: string) => void;
  variant?: "pill" | "field" | undefined;
  className?: string | undefined;
}) {
  const known = value !== undefined && efforts.some((e) => e.id === value);
  return (
    <Select
      label={label}
      value={known ? value : ""}
      options={effortOptions(efforts)}
      onSelect={onSelect}
      variant={variant}
      size={variant === "field" ? "md" : undefined}
      className={className}
    />
  );
}
