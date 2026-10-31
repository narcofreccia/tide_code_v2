import type { UserSettings } from "@tide/contracts";

/** The registry surface this needs: configured instance ids, their kind and label. */
export interface RegistryView {
  list(): string[];
  kindOf(id: string): string | undefined;
  labelOf(id: string): string | undefined;
}

/**
 * One system-prompt line telling an agent which harnesses `tide_delegate` can reach on this
 * machine and the model each one runs by default (the user's Settings › Providers choice), so a
 * request like "use OpenCode with the free GLM model" resolves to a concrete provider + model id.
 */
export function delegateTargetsHint(registry: RegistryView, defaults: UserSettings["providerDefaults"]): string | undefined {
  const parts: string[] = [];
  for (const id of registry.list()) {
    const kind = registry.kindOf(id);
    if (kind === undefined) continue;
    const model = defaults[id]?.model ?? (id === kind ? undefined : defaults[kind]?.model);
    const label = id === kind ? kind : `${kind} providerId ${id}${registry.labelOf(id) ? ` (${registry.labelOf(id)})` : ""}`;
    parts.push(model !== undefined && model !== "" ? `${label} (default model ${model})` : label);
  }
  if (parts.length === 0) return undefined;
  return `Harnesses tide_delegate can run here: ${parts.join("; ")}. Pass \`model\` only to override a default.`;
}
