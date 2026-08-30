import { useState } from "react";
import type { ProviderKind, ProviderStatusDto, RuntimeMode } from "@tide/contracts";
import { defaultModelOf, providerStatus, unavailableReason, useProviders } from "../../state/providers.ts";
import { providerDefault, useSettings } from "../../state/settings.ts";
import { PROVIDERS } from "../../lib/vocab.ts";
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
 * The per-provider defaults from Settings › Providers win over the harness's own
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
    useWorktree: useSettings.getState().worktreeByDefault,
  }));
  return [draft, (patch) => setDraft((prev) => ({ ...prev, ...patch }))];
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
  const providers = useProviders();
  const providerOptions: SelectOption<ProviderKind>[] = PROVIDERS.map((kind) => {
    const status = providerStatus(providers, kind);
    const reason = status ? unavailableReason(status) : undefined;
    return {
      value: kind,
      label: reason ? `${kind} · ${reason}` : kind,
      ...(reason === undefined ? {} : { disabled: true, title: reason }),
    };
  });
  const models = providerStatus(providers, draft.provider)?.models ?? [];
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "harness default" },
    ...models.map((m) => ({ value: m.id, label: m.label })),
  ];

  return (
    <>
      <label className={styles.field}>
        <span className={styles.label}>provider</span>
        <Select
          label="Thread provider"
          value={draft.provider}
          options={providerOptions}
          onSelect={(provider) => onChange(draftForProvider(provider, providers))}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>model</span>
        <Select
          label="Thread model"
          value={draft.model}
          options={modelOptions}
          onSelect={(model) => onChange({ model })}
        />
      </label>
      {showWorktree ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.useWorktree}
            onChange={(e) => onChange({ useWorktree: e.target.checked })}
          />
          use worktree
        </label>
      ) : null}
    </>
  );
}
