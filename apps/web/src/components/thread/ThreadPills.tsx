import type { ProviderKind, Thread } from "@tide/contracts";
import { INTERACTION_MODES, PROVIDERS, RUNTIME_MODES } from "../../lib/vocab.ts";
import { updateThread, type ThreadPatch } from "../../lib/threadActions.ts";
import { defaultModelOf, providerStatus, unavailableReason, useProviders } from "../../state/providers.ts";
import { showToast } from "../../state/toast.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./ThreadPills.module.css";

/**
 * provider / model / mode / interaction for a thread. The top bar and the
 * composer render the same component, so they can never drift.
 */
export function ThreadPills({ thread }: { thread: Thread }) {
  const providers = useProviders();
  const running = thread.status === "running";

  const providerOptions: SelectOption<ProviderKind>[] = PROVIDERS.map((kind) => {
    const status = providerStatus(providers, kind);
    const reason = status ? unavailableReason(status) : undefined;
    return {
      value: kind,
      label: reason ? `${kind} · ${reason}` : kind,
      ...(reason === undefined ? {} : { disabled: true, title: reason }),
    };
  });
  const models = providerStatus(providers, thread.provider)?.models ?? [];
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "harness default" },
    ...models.map((m) => ({ value: m.id, label: m.label })),
  ];

  const apply = (patch: ThreadPatch): void => updateThread(thread.id, patch);

  /**
   * Model / mode / interaction can be changed mid-turn: the harness picks them
   * up on the next turn, so say so once instead of silently disabling the pill.
   */
  const applyNextTurn = (patch: ThreadPatch): void => {
    apply(patch);
    if (running) showToast("Applies from the next turn");
  };

  return (
    <div className={styles.pills}>
      <Select
        label="Provider"
        value={thread.provider}
        options={providerOptions}
        disabled={running}
        onSelect={(provider) => {
          const model = defaultModelOf(providers, provider);
          apply({ provider, ...(model === undefined ? {} : { model }) });
        }}
      />
      <Select
        label="Model"
        value={thread.model ?? ""}
        options={modelOptions}
        onSelect={(model) => applyNextTurn({ model })}
      />
      <Select
        label="Mode"
        value={thread.mode}
        options={RUNTIME_MODES}
        onSelect={(mode) => applyNextTurn({ mode })}
      />
      <Select
        label="Interaction"
        value={thread.interaction}
        options={INTERACTION_MODES}
        onSelect={(interaction) => applyNextTurn({ interaction })}
      />
    </div>
  );
}
