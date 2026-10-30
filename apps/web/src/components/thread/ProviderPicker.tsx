import { useState } from "react";
import type { ProviderKind, ProviderStatusDto, RuntimeMode } from "@tide/contracts";
import {
  defaultModelOf,
  instanceGroup,
  modelChoiceValue,
  modelChoices,
  orderedInstances,
  placeholderStatus,
  providerStatus,
  unavailableReason,
  useProviderRoster,
  useProviders,
} from "../../state/providers.ts";
import { providerDefault, worktreeByDefault } from "../../state/serverSettings.ts";
import { BUNDLED_PROVIDERS, PROVIDER_LABELS, kindOfId } from "../../lib/vocab.ts";
import { Checkbox } from "../ui/Choice.tsx";
import { HarnessMark } from "../ui/StageList/StageCard.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./ProviderPicker.module.css";

export interface ThreadDraft {
  provider: ProviderKind;
  /** R8: the instance (account / ACP agent); equals `provider` for the bundled default */
  providerId: string;
  /** empty string means "let the harness choose" */
  model: string;
  /** R8: empty string means "the harness default effort" */
  effort: string;
  /** absent means "the harness default mode" */
  mode?: RuntimeMode;
  useWorktree: boolean;
}

/**
 * The per-instance defaults from Settings › Providers (server-side, shared with
 * every client) win over the harness's own default model; an explicit `model`
 * argument wins over both. `id` is an instance id or a bare kind.
 */
export function draftForProvider(
  id: string,
  providers: readonly ProviderStatusDto[],
  model = "",
): Omit<ThreadDraft, "useWorktree"> {
  const status = providerStatus(providers, id);
  const provider = status?.kind ?? kindOfId(id) ?? "claude";
  const providerId = status?.id || id;
  const saved = providerDefault(providerId);
  const chosen = model || saved.model || defaultModelOf(providers, providerId) || "";
  return { provider, providerId, model: chosen, effort: "", ...(saved.mode === undefined ? {} : { mode: saved.mode }) };
}

/** Draft state for the plan and new-thread pickers; switching harness re-picks its defaults. */
export function useThreadDraft(
  id: string,
  model = "",
  mode?: RuntimeMode,
): [ThreadDraft, (patch: Partial<ThreadDraft>) => void] {
  const providers = useProviders();
  const [draft, setDraft] = useState<ThreadDraft>(() => ({
    ...draftForProvider(id, providers, model),
    ...(mode === undefined ? {} : { mode }),
    useWorktree: worktreeByDefault(),
  }));
  return [draft, (patch) => setDraft((prev) => ({ ...prev, ...patch }))];
}

/**
 * Which instances a picker offers. `bundled`: the four default harnesses only —
 * for surfaces whose contract stores a bare kind (team stages, experts, automations,
 * forks, plan implementation). `all`: every configured account and ACP agent.
 */
export type InstanceScope = "bundled" | "all";

/** The Agent options: grouped, each disabled with its reason when not installed / logged in. */
export function instanceOptions(
  providers: readonly ProviderStatusDto[],
  loading: boolean,
  scope: InstanceScope,
): SelectOption<string>[] {
  const list =
    scope === "all"
      ? orderedInstances(providers)
      : BUNDLED_PROVIDERS.map((kind) => providerStatus(providers, kind) ?? placeholderStatus(kind));
  const grouped = new Set(list.map(instanceGroup)).size > 1;
  return list.map((p) => {
    const id = p.id || p.kind;
    const known = providerStatus(providers, id);
    const reason = loading ? "Checking harnesses…" : known ? unavailableReason(known) : "not installed";
    const name = p.label || PROVIDER_LABELS[p.kind];
    return {
      value: id,
      label: reason ? `${name} · ${loading ? "checking…" : reason}` : name,
      ...(grouped ? { group: instanceGroup(p) } : {}),
      ...(reason === undefined ? {} : { disabled: true, title: reason }),
    };
  });
}

/**
 * The harness + model pair on its own, so surfaces that pick a harness without a
 * worktree (the Experts panel's lead and expert rows) reuse the same lists.
 */
export function HarnessFields({
  name,
  provider,
  providerId,
  model,
  onChange,
  layout = "fields",
  instances = "bundled",
}: {
  /** prefixes the accessible labels, e.g. "Thread" → "Thread provider" */
  name: string;
  provider: ProviderKind;
  /** R8: the selected instance; absent = the kind's default */
  providerId?: string;
  model: string;
  onChange: (patch: Partial<ThreadDraft>) => void;
  /** `inline`: monogram + one joined Agent · Model control (composition cards) */
  layout?: "fields" | "inline";
  instances?: InstanceScope;
}) {
  const { providers, loading } = useProviderRoster();
  const id = providerId ?? provider;
  // nothing is known before `providers.list` answers, so nothing is offered
  const providerOptions = instanceOptions(providers, loading, instances);
  const models = providerStatus(providers, id)?.models ?? [];
  const modelOptions: SelectOption<string>[] = modelChoices(models, id, providers);
  const pick = (next: string): void => onChange(draftForProvider(next, providers));

  if (layout === "inline") {
    return (
      <div className={styles.inline} role="group" aria-label={`${name} agent and model`}>
        <HarnessMark provider={provider} />
        <div className={styles.joined}>
          <Select
            label={`${name} provider`}
            value={id}
            options={providerOptions}
            onSelect={pick}
            variant="field"
            size="md"
            className={styles.agent}
          />
          <Select
            label={`${name} model`}
            value={modelChoiceValue(models, model)}
            options={modelOptions}
            onSelect={(next) => onChange({ model: next, effort: "" })}
            variant="field"
            size="md"
            className={styles.model}
            align="end"
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>Agent</span>
        <Select
          label={`${name} provider`}
          value={id}
          options={providerOptions}
          onSelect={pick}
          variant="field"
          size="md"
        />
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Model</span>
        <Select
          label={`${name} model`}
          value={modelChoiceValue(models, model)}
          options={modelOptions}
          onSelect={(next) => onChange({ model: next, effort: "" })}
          variant="field"
          size="md"
        />
      </div>
    </>
  );
}

/** Harness + model + worktree fields, shared by PlanCard and the new-thread popover. */
export function ProviderPicker({
  draft,
  onChange,
  showWorktree = true,
}: {
  draft: ThreadDraft;
  onChange: (patch: Partial<ThreadDraft>) => void;
  showWorktree?: boolean;
}) {
  return (
    <>
      <HarnessFields name="Thread" provider={draft.provider} model={draft.model} onChange={onChange} />
      {showWorktree ? (
        <Checkbox
          className={styles.check}
          checked={draft.useWorktree}
          onChange={(e) => onChange({ useWorktree: e.target.checked })}
        >
          use worktree
        </Checkbox>
      ) : null}
    </>
  );
}
