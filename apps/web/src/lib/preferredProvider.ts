import type { ProviderKind, ProviderStatusDto } from "@tide/contracts";
import { orderedInstances, providerStatus } from "../state/providers.ts";
import { BUNDLED_PROVIDERS } from "./vocab.ts";

/** Installed and logged in: a thread on it can run its first turn. */
export function isUsable(p: Pick<ProviderStatusDto, "installed" | "loggedIn"> | undefined): boolean {
  return p !== undefined && p.installed && p.loggedIn;
}

/** The bundled kind a picker falls back to when it knows nothing. */
const FALLBACK: ProviderKind = BUNDLED_PROVIDERS[0] ?? "claude";

/**
 * Which instance a new thread / experts lead starts on. `preferred` (the harness the user last
 * chose, e.g. the project's newest thread) wins while it is usable; otherwise the first usable
 * instance in roster order; otherwise `preferred` anyway, so the picker still shows something and
 * the form says what to fix. An empty roster (still loading) never overrides the preference.
 * `bundled` limits the choice to the default instances (surfaces that store a bare kind).
 */
export function preferredProviderId(
  providers: readonly ProviderStatusDto[],
  preferred: string = FALLBACK,
  scope: "all" | "bundled" = "all",
): string {
  if (providers.length === 0) return preferred;
  if (isUsable(providerStatus(providers, preferred))) return preferred;
  const pool = orderedInstances(providers).filter((p) => scope === "all" || (p.kind !== "acp" && (p.id || p.kind) === p.kind));
  const first = pool.find((p) => isUsable(providerStatus(providers, p.id || p.kind)));
  return first === undefined ? preferred : first.id || first.kind;
}

/** `preferredProviderId` over the bundled kinds, typed as a kind (experts, team stages). */
export function preferredProviderKind(providers: readonly ProviderStatusDto[], preferred: ProviderKind = FALLBACK): ProviderKind {
  return preferredProviderId(providers, preferred, "bundled") as ProviderKind;
}
