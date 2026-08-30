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

/** Placeholder used before `providers.list` answers, so pickers stay usable. */
const FALLBACK: ProviderStatusDto[] = PROVIDERS.map((kind) => ({
  kind,
  installed: true,
  loggedIn: true,
  models: [],
  caps: {
    planMode: true,
    subagents: true,
    mcp: true,
    images: true,
    resume: true,
    contextUsage: true,
    openInTerminal: true,
  },
}));

export const useProvidersStore = create<ProvidersState>(() => ({
  providers: FALLBACK,
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
    .catch((err: unknown) =>
      useProvidersStore.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}

/** Cached harness roster; triggers the single `providers.list` call on first use. */
export function useProviders(): ProviderStatusDto[] {
  const providers = useProvidersStore((s) => s.providers);
  useEffect(() => loadProviders(), []);
  return providers;
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
  useProvidersStore.setState({ providers: FALLBACK, loading: false, error: null, requested: false });
}
