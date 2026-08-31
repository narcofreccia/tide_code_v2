import { useState } from "react";
import type { ExpertSpec, ProviderKind } from "@tide/contracts";
import { createExpertsSession } from "../../lib/expertsActions.ts";
import { DEFAULT_PRESET_KEYS, EXPERT_PRESETS, presetByKey } from "../../lib/expertPresets.ts";
import { useProviders } from "../../state/providers.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import { draftForProvider, HarnessFields } from "../thread/ProviderPicker.tsx";
import { ExpertRowEditor, type ExpertDraft } from "./ExpertRowEditor.tsx";
import styles from "./CreateExpertsDialog.module.css";

/** Keys must be unique within a session; a repeated preset gets a numeric suffix. */
function uniqueKey(base: string, taken: ExpertDraft[]): string {
  if (!taken.some((e) => e.key === base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.some((e) => e.key === candidate)) return candidate;
  }
}

function fromPreset(presetKey: string, taken: ExpertDraft[], provider: ProviderKind): ExpertDraft {
  const preset = presetByKey(presetKey);
  return {
    key: uniqueKey(preset?.key ?? "expert", taken),
    name: preset?.name ?? "Expert",
    role: preset?.role ?? "",
    provider: preset?.provider ?? provider,
    model: "",
    persona: preset?.persona ?? "",
  };
}

function initialExperts(provider: ProviderKind): ExpertDraft[] {
  const out: ExpertDraft[] = [];
  for (const key of DEFAULT_PRESET_KEYS) out.push(fromPreset(key, out, provider));
  return out;
}

function toSpec(expert: ExpertDraft): ExpertSpec {
  return {
    key: expert.key,
    name: expert.name.trim() || expert.key,
    role: expert.role.trim(),
    provider: expert.provider,
    ...(expert.model === "" ? {} : { model: expert.model }),
    ...(expert.persona.trim() === "" ? {} : { persona: expert.persona.trim() }),
  };
}

/** topic · lead harness · the panel roster. "Start" creates then starts the session. */
export function CreateExpertsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const providers = useProviders();
  const [topic, setTopic] = useState("");
  const [lead, setLead] = useState(() => draftForProvider("claude", providers));
  const [experts, setExperts] = useState<ExpertDraft[]>(() => initialExperts("claude"));
  const [preset, setPreset] = useState(EXPERT_PRESETS[0]?.key ?? "architect");
  const [busy, setBusy] = useState(false);

  const patchExpert = (index: number, patch: Partial<ExpertDraft>): void =>
    setExperts((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const move = (from: number, to: number): void =>
    setExperts((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });

  const canStart = topic.trim() !== "" && experts.length > 0 && !busy;

  const start = (): void => {
    if (!canStart) return;
    setBusy(true);
    void createExpertsSession({
      projectId,
      topic: topic.trim(),
      experts: experts.map(toSpec),
      lead: { provider: lead.provider, ...(lead.model === "" ? {} : { model: lead.model }) },
    })
      .then(() => onClose())
      .catch(() => setBusy(false));
  };

  return (
    <Dialog title="New experts session" onCancel={onClose}>
      <label className={styles.field}>
        <span className={styles.label}>topic</span>
        <textarea
          className={styles.topic}
          aria-label="Topic"
          placeholder="What should the panel work on?"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </label>

      <div className={styles.leadRow}>
        <span className={styles.label}>lead</span>
        <HarnessFields
          name="Lead"
          provider={lead.provider}
          model={lead.model}
          onChange={(patch) => setLead((prev) => ({ ...prev, ...patch }))}
        />
      </div>

      <div className={styles.expertsHead}>
        <span className={styles.label}>experts</span>
        <Select
          label="Preset"
          value={preset}
          options={EXPERT_PRESETS.map((p) => ({ value: p.key, label: p.name }))}
          onSelect={setPreset}
        />
        <Button onClick={() => setExperts((prev) => [...prev, fromPreset(preset, prev, lead.provider)])}>
          + add expert
        </Button>
      </div>

      <ul className={styles.list}>
        {experts.map((expert, index) => (
          <ExpertRowEditor
            key={expert.key}
            expert={expert}
            index={index}
            count={experts.length}
            onChange={(patch) => patchExpert(index, patch)}
            onMove={(to) => move(index, to)}
            onRemove={() => setExperts((prev) => prev.filter((_, i) => i !== index))}
          />
        ))}
      </ul>

      <div className={styles.actions}>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canStart} onClick={start}>
          Start
        </Button>
      </div>
    </Dialog>
  );
}
