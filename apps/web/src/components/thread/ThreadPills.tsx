import type { InteractionMode, ProviderKind, Thread } from "@tide/contracts";
import {
  DEFAULT_MODEL_LABEL,
  INTERACTION_HINTS,
  INTERACTION_LABELS,
  INTERACTION_MODES,
  PROVIDERS,
  PROVIDER_LABELS,
  RUNTIME_MODES,
  RUNTIME_MODE_HINTS,
  RUNTIME_MODE_LABELS,
  defaultModelHint,
} from "../../lib/vocab.ts";
import { updateThread, type ThreadPatch } from "../../lib/threadActions.ts";
import { defaultModelOf, providerStatus, unavailableReason, useProviders } from "../../state/providers.ts";
import { showToast } from "../../state/toast.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./ThreadPills.module.css";

/** Caption + control; the caption is what makes a bare value like "Auto" readable. */
function Slot({ caption, hint, children }: { caption: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={styles.slot} {...(hint === undefined ? {} : { title: hint })}>
      <span className={styles.caption}>{caption}</span>
      {children}
    </div>
  );
}

/** Build | Plan as two always-visible choices instead of a dropdown. */
function InteractionToggle({
  value,
  onChange,
}: {
  value: InteractionMode;
  onChange: (mode: InteractionMode) => void;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Interaction">
      {INTERACTION_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          title={INTERACTION_HINTS[mode]}
          className={`${styles.segment} ${value === mode ? styles.active : ""}`}
          onClick={() => value !== mode && onChange(mode)}
        >
          {INTERACTION_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

/**
 * Agent / model / permissions / build-or-plan for a thread. Lives in the
 * composer only: the settings that shape the next message sit next to it.
 */
export function ThreadPills({ thread }: { thread: Thread }) {
  const providers = useProviders();
  const running = thread.status === "running";

  const providerOptions: SelectOption<ProviderKind>[] = PROVIDERS.map((kind) => {
    const status = providerStatus(providers, kind);
    const reason = status ? unavailableReason(status) : undefined;
    const name = PROVIDER_LABELS[kind];
    return {
      value: kind,
      label: reason ? `${name} · ${reason}` : name,
      ...(reason === undefined ? {} : { disabled: true, title: reason }),
    };
  });
  const models = providerStatus(providers, thread.provider)?.models ?? [];
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: DEFAULT_MODEL_LABEL, description: defaultModelHint(thread.provider) },
    ...models.map((m) => ({ value: m.id, label: m.label })),
  ];
  const modeOptions: SelectOption<Thread["mode"]>[] = RUNTIME_MODES.map((mode) => ({
    value: mode,
    label: RUNTIME_MODE_LABELS[mode],
    description: RUNTIME_MODE_HINTS[mode],
  }));

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
      <Slot caption="Agent" hint="Which coding harness runs this thread">
        <Select
          label="Provider"
          className={styles.control}
          value={thread.provider}
          options={providerOptions}
          disabled={running}
          onSelect={(provider) => {
            const model = defaultModelOf(providers, provider);
            apply({ provider, ...(model === undefined ? {} : { model }) });
          }}
        />
      </Slot>
      <Slot caption="Model" hint="The model the agent uses for its next turn">
        <Select
          label="Model"
          className={styles.control}
          value={thread.model ?? ""}
          options={modelOptions}
          onSelect={(model) => applyNextTurn({ model })}
        />
      </Slot>
      <Slot caption="Permissions" hint={RUNTIME_MODE_HINTS[thread.mode]}>
        <Select
          label="Permissions"
          className={styles.control}
          value={thread.mode}
          options={modeOptions}
          onSelect={(mode) => applyNextTurn({ mode })}
        />
      </Slot>
      <Slot caption="Mode" hint={INTERACTION_HINTS[thread.interaction]}>
        <InteractionToggle value={thread.interaction} onChange={(interaction) => applyNextTurn({ interaction })} />
      </Slot>
    </div>
  );
}
