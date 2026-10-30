import { useEffect } from "react";
import { create } from "zustand";
import type { ProviderKind, ProviderStatusDto } from "@tide/contracts";
import { call } from "./model.ts";
import {
  BUNDLED_PROVIDERS,
  DEFAULT_MODEL_LABEL,
  PROVIDER_LABELS,
  defaultModelHint,
  harnessDefaultHint,
  instanceLabel,
  providerIdOf,
  threadHarnessLabel,
} from "../lib/vocab.ts";

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
  return BUNDLED_PROVIDERS.map((kind) => ({
    id: kind, kind, label: PROVIDER_LABELS[kind], installed: false, loggedIn: false, models: [], caps: NO_CAPS, hint,
  }));
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

/**
 * The status of an instance: by `id` first, then the default instance of a bare
 * kind (`"codex"` → the bundled Codex). An ACP kind has no default instance.
 */
export function providerStatus(
  providers: readonly ProviderStatusDto[],
  idOrKind: string,
): ProviderStatusDto | undefined {
  return (
    providers.find((p) => p.id === idOrKind) ??
    // a server that predates instances sends no id: its single entry per kind is the default
    providers.find((p) => p.kind === idOrKind && (p.id === undefined || p.id === "" || p.id === p.kind))
  );
}

/** The status behind a thread's instance (`providerId`, else its kind's default). */
export function threadProviderStatus(
  providers: readonly ProviderStatusDto[],
  thread: { provider: ProviderKind; providerId?: string },
): ProviderStatusDto | undefined {
  return providerStatus(providers, providerIdOf(thread));
}

/**
 * The model the harness marks as its default. Undefined when it names none: the
 * thread then sends no model and the harness picks ("Default model" entry).
 */
export function defaultModelOf(providers: readonly ProviderStatusDto[], id: string): string | undefined {
  return providerStatus(providers, id)?.models.find((m) => m.default)?.id;
}

/** Reads the cached roster without triggering a fetch (labels on rows that must not probe). */
export function useProvidersSnapshot(): ProviderStatusDto[] {
  return useProvidersStore((s) => s.providers);
}

/** A thread's harness name for display: the instance label when it differs from the kind's. */
export function useThreadHarnessLabel(thread: { provider: ProviderKind; providerId?: string }): string {
  const providers = useProvidersSnapshot();
  return threadHarnessLabel(providers, thread);
}

export interface ModelChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * The model list a picker offers. When the harness marks one of its models as
 * the default, that entry carries the "default" hint and stands for "no explicit
 * model"; only a harness that names no default gets the synthetic entry.
 */
export function modelChoices(
  models: ProviderStatusDto["models"],
  id: string,
  providers: readonly ProviderStatusDto[] = [],
): ModelChoice[] {
  const name = instanceLabel(providers, id);
  const listed = models.map((m) => ({
    value: m.id,
    label: m.label,
    ...(m.default ? { description: harnessDefaultHint(name) } : {}),
  }));
  if (models.some((m) => m.default)) return listed;
  return [{ value: "", label: DEFAULT_MODEL_LABEL, description: defaultModelHint(name) }, ...listed];
}

/** The picker value for a stored model: unset shows as the harness's own default entry. */
export function modelChoiceValue(models: ProviderStatusDto["models"], model: string | undefined): string {
  if (model !== undefined && model !== "") return model;
  return models.find((m) => m.default)?.id ?? "";
}

export type Effort = NonNullable<ProviderStatusDto["models"][number]["efforts"]>[number];

/** Default ("") → each level → Default; an unknown stored value restarts the cycle. */
export function nextEffort(efforts: readonly Effort[], current: string | undefined): string {
  const order = ["", ...efforts.map((e) => e.id)];
  const at = order.indexOf(current ?? "");
  return order[(at + 1) % order.length] ?? "";
}

/** The effort levels of a model (the stored one, else the harness default); empty when it has none. */
export function effortsOf(
  models: ProviderStatusDto["models"],
  model: string | undefined,
): Effort[] {
  const id = modelChoiceValue(models, model);
  return models.find((m) => m.id === id)?.efforts ?? [];
}

/** Bundled defaults first, then extra accounts of bundled kinds, then ACP agents; stable within a group. */
export type InstanceGroup = "Harnesses" | "Accounts" | "ACP agents";

export function instanceGroup(p: { id: string; kind: ProviderKind }): InstanceGroup {
  if (p.kind === "acp") return "ACP agents";
  return p.id === p.kind ? "Harnesses" : "Accounts";
}

const GROUP_ORDER: InstanceGroup[] = ["Harnesses", "Accounts", "ACP agents"];

/**
 * Every instance a picker can offer, grouped. The four bundled kinds always appear
 * (a missing one reads "not installed"), so the list is stable before and after a probe.
 */
export function orderedInstances(providers: readonly ProviderStatusDto[]): ProviderStatusDto[] {
  const byId = new Map<string, ProviderStatusDto>();
  for (const kind of BUNDLED_PROVIDERS) {
    byId.set(kind, providerStatus(providers, kind) ?? placeholderStatus(kind));
  }
  for (const p of providers) {
    const id = p.id || p.kind;
    if (!byId.has(id)) byId.set(id, p);
  }
  const all = [...byId.values()];
  return GROUP_ORDER.flatMap((group) => all.filter((p) => instanceGroup(p) === group));
}

/** A bundled kind the server did not report still gets an entry, so the set is stable. */
export function placeholderStatus(kind: ProviderKind, id: string = kind, label: string = PROVIDER_LABELS[kind]): ProviderStatusDto {
  return { id, kind, label, installed: false, loggedIn: false, hint: "driver not available in this build", models: [], caps: { ...NO_CAPS } };
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
