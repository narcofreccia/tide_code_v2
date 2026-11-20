import type { UserSettings } from "@tide/contracts";

/** The registry surface this needs: configured instance ids, their kind and label. */
export interface RegistryView {
  list(): string[];
  kindOf(id: string): string | undefined;
  labelOf(id: string): string | undefined;
  /** model ids from the instance's last status read, if any (the harness's own list) */
  cachedModels?(id: string): string[] | undefined;
}

/** Enough to choose from without flooding every system prompt. */
const MAX_MODELS = 16;

/**
 * One system-prompt line telling an agent which harnesses `tide_delegate` can reach on this
 * machine and the model each one runs by default (the user's Settings › Providers choice), so a
 * request like "use OpenCode with the free GLM model" resolves to a concrete provider + model id.
 * The model ids each harness reported are listed too: a list can be partial (Claude Code takes
 * ids it does not list), so they guide the choice and nothing is refused on them.
 */
export function delegateTargetsHint(registry: RegistryView, defaults: UserSettings["providerDefaults"]): string | undefined {
  const parts: string[] = [];
  for (const id of registry.list()) {
    const kind = registry.kindOf(id);
    if (kind === undefined) continue;
    const model = defaults[id]?.model ?? (id === kind ? undefined : defaults[kind]?.model);
    const label = id === kind ? kind : `${kind} providerId ${id}${registry.labelOf(id) ? ` (${registry.labelOf(id)})` : ""}`;
    const known = registry.cachedModels?.(id) ?? [];
    const listed = known.length > 0 ? `, models ${known.slice(0, MAX_MODELS).join(", ")}${known.length > MAX_MODELS ? ", …" : ""}` : "";
    parts.push(`${label}${model !== undefined && model !== "" ? ` (default model ${model}${listed})` : listed !== "" ? ` (${listed.slice(2)})` : ""}`);
  }
  if (parts.length === 0) return undefined;
  // Orchestrators guessed ids from prose ("opus-5.5", "gpt-6.2") and the delegate died on its first turn.
  return `Harnesses tide_delegate can run here: ${parts.join("; ")}. Pass \`model\` only to override a default, and then use an id exactly as listed (never one built from a model's display name).`;
}
