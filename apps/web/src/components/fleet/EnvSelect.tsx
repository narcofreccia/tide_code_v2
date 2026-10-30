import { environmentName, useEnvironments } from "../../state/environments.ts";
import { Select } from "../ui/Select.tsx";
import { connectedEnvs } from "./envView.ts";

/**
 * "Run on <machine>": the connected environments, primary first. Renders nothing while
 * there is only one, so single-machine users never see it.
 */
export function EnvSelect({
  value,
  onSelect,
  label = "Run on",
  className,
}: {
  value: string | undefined;
  onSelect: (envId: string) => void;
  label?: string;
  className?: string;
}) {
  const state = useEnvironments();
  const live = connectedEnvs(state);
  if (live.length < 2) return null;
  const options = live.map((env) => ({
    value: env.id,
    label: environmentName(env.id),
    ...(env.id === state.primaryId ? { description: "primary" } : {}),
  }));
  return (
    <Select
      label={label}
      value={value ?? state.primaryId ?? live[0]?.id ?? ""}
      options={options}
      onSelect={onSelect}
      variant="field"
      size="md"
      {...(className === undefined ? {} : { className })}
    />
  );
}

/** How many machines are connected; the forms show their picker past one. */
export function useConnectedCount(): number {
  return useEnvironments((s) => s.environments.filter((e) => s.statuses[e.id]?.connection === "connected").length);
}
