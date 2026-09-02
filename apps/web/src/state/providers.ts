import { useEffect } from "react";
import { create } from "zustand";
import type { ProviderKind, ProviderStatusDto } from "@tide/contracts";
import { call } from "./model.ts";
import { PROVIDERS } from "../lib/vocab.ts";

interface ProvidersState {
  providers: ProviderStatusDto[];
  loading: boolean;
  error: string | null;
  /** set once a `providers.list` call started, so the hook only fetches once */
  requested: boolean;
}

const NO_CAPS: ProviderStatusDto["caps"] = {
  planMode: false,
  subagents: false,
  mcp: false,
  images: false,
  resume: false,
  contextUsage: false,
  openInTerminal: false,
};

/**
 * What the roster looks like when the server could not be asked. A harness is
 * never presented as ready unless the server said so, so a failed probe reads as
 * "not installed" with the reason attached rather than as four working harnesses.
 */
function unknownRoster(hint: string): ProviderStatusDto[] {
  return PROVIDERS.map((kind) => ({ kind, installed: false, loggedIn: false, models: [], caps: NO_CAPS, hint }));
}

export const useProvidersStore = create<ProvidersState>(() => ({
  providers: [],
  loading: false,
  error: null,
  requested: false,
}));

/** Fetches the harness roster once per session; `refresh` forces a re-probe. */
export function loadProviders(refresh = false): void {
  const state = useProvidersStore.getState();
  if (state.loading || (state.requested && !refresh)) return;
  useProvidersStore.setState({ loading: true, requested: true, error: null });
  call("providers.list", refresh ? { refresh: true } : {})
    .then((providers) => useProvidersStore.setState({ providers, loading: false }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      useProvidersStore.setState({ loading: false, error, providers: unknownRoster(error) });
    });
}

export interface ProviderRoster {
  providers: ProviderStatusDto[];
  /** the first `providers.list` has not answered yet — nothing is known */
  loading: boolean;
  error: string | null;
}

/**
 * The roster with its liveness: until the server answers, callers must show
 * "checking" rather than guessing, so the UI never offers a harness that may not
 * be there. Triggers the single `providers.list` call on first use.
 */
export function useProviderRoster(): ProviderRoster {
  const providers = useProvidersStore((s) => s.providers);
  const loading = useProvidersStore((s) => s.loading);
  const error = useProvidersStore((s) => s.error);
  useEffect(() => loadProviders(), []);
  return { providers, loading: loading || (providers.length === 0 && error === null), error };
}

/** Cached harness roster; triggers the single `providers.list` call on first use. */
export function useProviders(): ProviderStatusDto[] {
  return useProviderRoster().providers;
}

export function providerStatus(
  providers: ProviderStatusDto[],
  kind: ProviderKind,
): ProviderStatusDto | undefined {
  return providers.find((p) => p.kind === kind);
}

/** The harness's own default model id, else its first. */
export function defaultModelOf(providers: ProviderStatusDto[], kind: ProviderKind): string | undefined {
  const models = providerStatus(providers, kind)?.models ?? [];
  return (models.find((m) => m.default) ?? models[0])?.id;
}

/** Why a provider cannot be used, if it cannot. */
export function unavailableReason(p: ProviderStatusDto): string | undefined {
  if (!p.installed) return p.hint ?? "not installed";
  if (!p.loggedIn) return p.hint ?? "not logged in";
  return undefined;
}

/** Test seam: replaces the roster without touching the connection. */
export function setProvidersForTest(providers: ProviderStatusDto[]): void {
  useProvidersStore.setState({ providers, loading: false, error: null, requested: true });
}

export function resetProviders(): void {
  useProvidersStore.setState({ providers: [], loading: false, error: null, requested: false });
}
