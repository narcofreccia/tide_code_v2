import { useState } from "react";
import type { ProviderKind, ProviderStatusDto, RuntimeMode } from "@tide/contracts";
import {
  defaultModelOf,
  providerStatus,
  unavailableReason,
  useProviderRoster,
  useProviders,
} from "../../state/providers.ts";
import { providerDefault, worktreeByDefault } from "../../state/serverSettings.ts";
import { PROVIDERS } from "../../lib/vocab.ts";
import { Checkbox } from "../ui/Choice.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./ProviderPicker.module.css";

export interface ThreadDraft {
  provider: ProviderKind;
  /** empty string means "let the harness choose" */
  model: string;
  /** absent means "the harness default mode" */
  mode?: RuntimeMode;
  useWorktree: boolean;
}

/**
 * The per-provider defaults from Settings › Providers (server-side, shared with
 * every client) win over the harness's own
 * default model; an explicit `model` argument wins over both.
 */
export function draftForProvider(
  provider: ProviderKind,
  providers: ProviderStatusDto[],
  model = "",
): Omit<ThreadDraft, "useWorktree"> {
  const saved = providerDefault(provider);
  const chosen = model || saved.model || defaultModelOf(providers, provider) || "";
  return { provider, model: chosen, ...(saved.mode === undefined ? {} : { mode: saved.mode }) };
}

/** Draft state for the plan and new-thread pickers; switching harness re-picks its defaults. */
export function useThreadDraft(provider: ProviderKind, model = ""): [ThreadDraft, (patch: Partial<ThreadDraft>) => void] {
  const providers = useProviders();
  const [draft, setDraft] = useState<ThreadDraft>(() => ({
    ...draftForProvider(provider, providers, model),
    useWorktree: worktreeByDefault(),
  }));
  return [draft, (patch) => setDraft((prev) => ({ ...prev, ...patch }))];
}

/**
 * The harness + model pair on its own, so surfaces that pick a harness without a
 * worktree (the Experts panel's lead and expert rows) reuse the same lists.
 */
export function HarnessFields({
  name,
  provider,
  model,
  onChange,
}: {
  /** prefixes the accessible labels, e.g. "Thread" → "Thread provider" */
  name: string;
  provider: ProviderKind;
  model: string;
  onChange: (patch: Partial<ThreadDraft>) => void;
}) {
  const { providers, loading } = useProviderRoster();
  // nothing is known before `providers.list` answers, so nothing is offered
  const providerOptions: SelectOption<ProviderKind>[] = PROVIDERS.map((kind) => {
    const status = providerStatus(providers, kind);
    const reason = loading ? "Checking harnesses…" : status ? unavailableReason(status) : "not installed";
    return {
      value: kind,
      label: reason ? `${kind} · ${loading ? "checking…" : reason}` : kind,
      ...(reason === undefined ? {} : { disabled: true, title: reason }),
    };
  });
  const models = providerStatus(providers, provider)?.models ?? [];
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "harness default" },
    ...models.map((m) => ({ value: m.id, label: m.label })),
  ];

  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>provider</span>
        <Select
          label={`${name} provider`}
          value={provider}
          options={providerOptions}
          onSelect={(kind) => onChange(draftForProvider(kind, providers))}
          variant="field"
          size="md"
        />
      </div>
      <div className={styles.field}>
        <span className={styles.label}>model</span>
        <Select
          label={`${name} model`}
          value={model}
          options={modelOptions}
          onSelect={(next) => onChange({ model: next })}
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
