import { useState } from "react";
import type { ProviderKind } from "@tide/contracts";
import { defaultModelOf, providerStatus, unavailableReason, useProviders } from "../../state/providers.ts";
import { PROVIDERS } from "../../lib/vocab.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./ProviderPicker.module.css";

export interface ThreadDraft {
  provider: ProviderKind;
  /** empty string means "let the harness choose" */
  model: string;
  useWorktree: boolean;
}

/** Draft state for the plan and new-thread pickers; switching harness re-picks its default model. */
export function useThreadDraft(provider: ProviderKind, model = ""): [ThreadDraft, (patch: Partial<ThreadDraft>) => void] {
  const [draft, setDraft] = useState<ThreadDraft>({ provider, model, useWorktree: true });
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
          onSelect={(provider) => onChange({ provider, model: defaultModelOf(providers, provider) ?? "" })}
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
