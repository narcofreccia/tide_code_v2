import { useState } from "react";
import type { ExpertSpec, ProviderKind } from "@tide/contracts";
import { createExpertsSession } from "../../lib/expertsActions.ts";
import { DEFAULT_PRESET_KEYS, EXPERT_PRESETS, presetByKey } from "../../lib/expertPresets.ts";
import { useModel } from "../../state/model.ts";
import { useProviders } from "../../state/providers.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { DialogFrame, FrameSection, PrimaryField } from "../ui/DialogFrame.tsx";
import { PresetChips } from "../ui/StageList/PresetChips.tsx";
import { StageCard, StageSubtitle, StageTitle } from "../ui/StageList/StageCard.tsx";
import { StageList } from "../ui/StageList/StageList.tsx";
import { draftForProvider, HarnessFields } from "../thread/ProviderPicker.tsx";
import { defaultPersona, ExpertRowEditor, type ExpertDraft } from "./ExpertRowEditor.tsx";

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
    persona: "",
    ...(preset === undefined ? {} : { presetKey: preset.key }),
  };
}

function blankExpert(taken: ExpertDraft[], provider: ProviderKind): ExpertDraft {
  return { key: uniqueKey("expert", taken), name: "", role: "", provider, model: "", persona: "" };
}

function initialExperts(provider: ProviderKind): ExpertDraft[] {
  const out: ExpertDraft[] = [];
  for (const key of DEFAULT_PRESET_KEYS) out.push(fromPreset(key, out, provider));
  return out;
}

function toSpec(expert: ExpertDraft, index: number): ExpertSpec {
  const persona = expert.persona.trim() || defaultPersona(expert);
  return {
    key: expert.key,
    name: expert.name.trim() || `Expert ${index + 1}`,
    role: expert.role.trim(),
    provider: expert.provider,
    ...(expert.model === "" ? {} : { model: expert.model }),
    ...(persona === "" ? {} : { persona }),
  };
}

function blockedReason(topic: string, count: number, busy: boolean): string | undefined {
  if (busy) return "Starting…";
  if (topic.trim() === "") return "Add a topic to start";
  if (count === 0) return "Add at least one expert";
  return undefined;
}

/** topic · preset chips · lead card · expert cards. "Start" creates then starts the session. */
export function CreateExpertsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const providers = useProviders();
  const projectTitle = useModel((s) => s.model.projects[projectId]?.title);
  const [topic, setTopic] = useState("");
  const [lead, setLead] = useState(() => draftForProvider("claude", providers));
  const [experts, setExperts] = useState<ExpertDraft[]>(() => initialExperts("claude"));
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

  const togglePreset = (key: string): void =>
    setExperts((prev) => {
      const at = prev.findIndex((e) => e.presetKey === key);
      if (at >= 0) return prev.filter((_, i) => i !== at);
      return [...prev, fromPreset(key, prev, lead.provider)];
    });

  const blocked = blockedReason(topic, experts.length, busy);

  const start = (): void => {
    if (blocked !== undefined) return;
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

  const count = experts.length;
  return (
    <Dialog title="New experts session" onCancel={onClose} variant="sheet">
      <DialogFrame
        heading="Ask a panel of experts to agree on one plan"
        {...(projectTitle === undefined ? {} : { context: `In ${projectTitle}` })}
        outcome="Each expert explores in its own thread; the lead gathers their findings and proposes a plan you can hand to a Team run."
        primaryLabel={count === 1 ? "Start with 1 expert" : `Start with ${count} experts`}
        onPrimary={start}
        blockedReason={blocked}
        onCancel={onClose}
        bodyTestId="experts-dialog-body"
      >
        <PrimaryField
          label="Topic"
          ariaLabel="Topic"
          multiline
          placeholder="Should we move auth to the edge?"
          value={topic}
          onChange={setTopic}
        />

        <FrameSection title="Panel" aside={`${count} ${count === 1 ? "expert" : "experts"} · mix harnesses freely`}>
          <PresetChips
            label="Presets"
            chips={EXPERT_PRESETS.map((p) => ({
              key: p.key,
              label: p.name,
              pressed: experts.some((e) => e.presetKey === p.key),
              title: p.role,
            }))}
            onToggle={togglePreset}
          />
          <StageList label="Lead" flow="parallel">
            <StageCard
              marker="◆"
              tone="lead"
              label="Lead"
              title={<StageTitle>Lead</StageTitle>}
              subtitle={<StageSubtitle>Gathers findings, writes the plan</StageSubtitle>}
              harness={
                <HarnessFields
                  layout="inline"
                  name="Lead"
                  provider={lead.provider}
                  model={lead.model}
                  onChange={(patch) => setLead((prev) => ({ ...prev, ...patch }))}
                />
              }
            />
          </StageList>
          <StageList
            label="Experts"
            flow="parallel"
            add={{
              label: "Add an expert",
              hint: "a blank seat you describe yourself",
              onClick: () => setExperts((prev) => [...prev, blankExpert(prev, lead.provider)]),
            }}
          >
            {experts.map((expert, index) => (
              <ExpertRowEditor
                key={expert.key}
                expert={expert}
                index={index}
                count={count}
                onChange={(patch) => patchExpert(index, patch)}
                onMove={(to) => move(index, to)}
                onRemove={() => setExperts((prev) => prev.filter((_, i) => i !== index))}
              />
            ))}
          </StageList>
        </FrameSection>
      </DialogFrame>
    </Dialog>
  );
}
