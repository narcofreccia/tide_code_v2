import { memo } from "react";
import type { InteractionMode, Thread } from "@tide/contracts";
import {
  INTERACTION_HINTS,
  INTERACTION_LABELS,
  INTERACTION_MODES,
  instanceLabel,
  providerIdOf,
  runtimeModeHint,
  runtimeModeOptions,
} from "../../lib/vocab.ts";
import { updateThread, type ThreadPatch } from "../../lib/threadActions.ts";
import {
  effortsOf,
  modelChoiceValue,
  modelChoices,
  providerStatus,
  useProviders,
  validModelFor,
} from "../../state/providers.ts";
import { envOfThread } from "../../state/environments.ts";
import { providerDefault } from "../../state/serverSettings.ts";
import { EffortSelect } from "./EffortSelect.tsx";
import { instanceOptions } from "./ProviderPicker.tsx";
import { showToast } from "../../state/toast.ts";
import { limitModeOptions, useThreadDeviceLimit } from "../../state/deviceAccess.ts";
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
  planMode,
  harness,
}: {
  value: InteractionMode;
  onChange: (mode: InteractionMode) => void;
  /** the harness has a native plan mode; without it Plan is hidden (or disabled when the thread is already in it) */
  planMode: boolean;
  harness: string;
}) {
  const hidden = !planMode && value !== "plan";
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Interaction">
      {INTERACTION_MODES.filter((mode) => mode !== "plan" || !hidden).map((mode) => {
        const noPlan = mode === "plan" && !planMode;
        return (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          disabled={noPlan}
          title={noPlan ? `${harness} has no plan mode` : INTERACTION_HINTS[mode]}
          className={`${styles.segment} ${value === mode ? styles.active : ""}`}
          onClick={() => value !== mode && onChange(mode)}
        >
          {INTERACTION_LABELS[mode]}
        </button>
        );
      })}
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
  const limit = useThreadDeviceLimit(thread.id);

  const id = providerIdOf(thread);
  const envId = envOfThread(thread.id);
  const listed = instanceOptions(providers, false, "all");
  // an instance removed from Settings still shows as the thread's current agent
  const providerOptions: SelectOption<string>[] = listed.some((o) => o.value === id)
    ? listed
    : [...listed, { value: id, label: `${instanceLabel(providers, id)} · not configured`, disabled: true }];
  const currentStatus = providerStatus(providers, id, envId) ?? providerStatus(providers, id);
  const models = currentStatus?.models ?? [];
  const listedModels: SelectOption<string>[] = modelChoices(models, id, providers);
  const selectedModel = modelChoiceValue(models, thread.model);
  // a model stored on the thread that this harness does not list stays visible instead of showing "Select…"
  const modelOptions: SelectOption<string>[] =
    selectedModel !== "" && models.length > 0 && !listedModels.some((o) => o.value === selectedModel)
      ? [...listedModels, { value: selectedModel, label: `${selectedModel} · not listed`, disabled: true }]
      : listedModels;
  const efforts = effortsOf(models, thread.model);
  // R19: Full access is refused for a device with limited access on the thread's machine
  // captions per harness where `auto` means something else (vocab.ts RUNTIME_MODE_KIND_HINTS)
  const modeOptions: SelectOption<Thread["mode"]>[] = limitModeOptions(runtimeModeOptions(thread.provider), limit);

  const apply = (patch: ThreadPatch): void => updateThread(thread.id, patch);

  /**
   * Model / effort / interaction can be changed mid-turn: the harness picks them
   * up on the next turn, so say so once instead of silently disabling the pill.
   * Permissions take effect immediately via live reconfigure.
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
            const status = providerStatus(providers, next, envId) ?? providerStatus(providers, next);
            if (status === undefined) return;
            const saved = validModelFor(status.models, providerDefault(next).model);
            const model = saved ?? status.models.find((m) => m.default)?.id;
            apply({ provider: status.kind, providerId: next, ...(model === undefined ? {} : { model }) });
          }}
        />
      </Slot>
      <Slot caption="Model" hint="The model the agent uses for its next turn">
        <Select
          label="Model"
          className={styles.control}
          value={selectedModel}
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
      <Slot caption="Permissions" hint={runtimeModeHint(thread.mode, thread.provider)}>
        <Select
          label="Permissions"
          className={styles.control}
          value={thread.mode}
          options={modeOptions}
          onSelect={(mode) => apply({ mode })}
        />
      </Slot>
      <Slot caption="Mode" hint={INTERACTION_HINTS[thread.interaction]}>
        <InteractionToggle
          value={thread.interaction}
          onChange={(interaction) => applyNextTurn({ interaction })}
          planMode={currentStatus?.caps.planMode !== false}
          harness={instanceLabel(providers, id)}
        />
      </Slot>
    </div>
  );
});
