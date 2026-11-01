import { memo } from "react";
import type { InteractionMode, Thread } from "@tide/contracts";
import {
  INTERACTION_HINTS,
  INTERACTION_LABELS,
  INTERACTION_MODES,
  RUNTIME_MODES,
  RUNTIME_MODE_HINTS,
  RUNTIME_MODE_LABELS,
  instanceLabel,
  providerIdOf,
} from "../../lib/vocab.ts";
import { updateThread, type ThreadPatch } from "../../lib/threadActions.ts";
import {
  defaultModelOf,
  effortsOf,
  modelChoiceValue,
  modelChoices,
  providerStatus,
  useProviders,
} from "../../state/providers.ts";
import { EffortSelect } from "./EffortSelect.tsx";
import { instanceOptions } from "./ProviderPicker.tsx";
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
 * Memoized: the thread object is stable across keystrokes and streaming deltas.
 */
export const ThreadPills = memo(function ThreadPills({ thread }: { thread: Thread }) {
  const providers = useProviders();
  const running = thread.status === "running";

  const id = providerIdOf(thread);
  const listed = instanceOptions(providers, false, "all");
  // an instance removed from Settings still shows as the thread's current agent
  const providerOptions: SelectOption<string>[] = listed.some((o) => o.value === id)
    ? listed
    : [...listed, { value: id, label: `${instanceLabel(providers, id)} · not configured`, disabled: true }];
  const models = providerStatus(providers, id)?.models ?? [];
  const modelOptions: SelectOption<string>[] = modelChoices(models, id, providers);
  const efforts = effortsOf(models, thread.model);
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
          value={id}
          options={providerOptions}
          disabled={running}
          onSelect={(next) => {
            const status = providerStatus(providers, next);
            if (status === undefined) return;
            const model = defaultModelOf(providers, next);
            apply({ provider: status.kind, providerId: next, ...(model === undefined ? {} : { model }) });
          }}
        />
      </Slot>
      <Slot caption="Model" hint="The model the agent uses for its next turn">
        <Select
          label="Model"
          className={styles.control}
          value={modelChoiceValue(models, thread.model)}
          options={modelOptions}
          onSelect={(model) => {
            // effort ids are per model: keep the level only when the new model has it too
            const keeps = thread.effort === undefined || effortsOf(models, model).some((e) => e.id === thread.effort);
            applyNextTurn({ model, ...(keeps ? {} : { effort: "" }) });
          }}
        />
      </Slot>
      {efforts.length === 0 ? null : (
        <Slot caption="Effort" hint="How hard the model thinks (⌘⇧R cycles)">
          <EffortSelect
            label="Effort"
            className={styles.control}
            efforts={efforts}
            value={thread.effort}
            onSelect={(effort) => applyNextTurn({ effort })}
          />
        </Slot>
      )}
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
});
