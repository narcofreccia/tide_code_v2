import { useState } from "react";
import type { InteractionMode, RuntimeMode, Team } from "@tide/contracts";
import {
  INTERACTION_LABELS,
  INTERACTION_MODES,
  RUNTIME_MODE_HINTS,
  RUNTIME_MODE_LABELS,
  RUNTIME_MODES,
} from "../../lib/vocab.ts";
import { HarnessFields } from "../thread/ProviderPicker.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { DialogFrame, FrameSection, PrimaryField } from "../ui/DialogFrame.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { StageCard, stageMarker, StageSetting, StageSettings, StageSettingText, StageTitleInput } from "../ui/StageList/StageCard.tsx";
import { StageList } from "../ui/StageList/StageList.tsx";
import { StageNote } from "../ui/StageList/StageNote.tsx";
import { MAX_STAGES, blankStage, draftFromTeam, teamFromDraft, type StageDraft, type TeamDraft } from "./teamDraft.ts";

const MODE_OPTIONS: SelectOption<RuntimeMode | "">[] = [
  { value: "", label: "Harness default" },
  ...RUNTIME_MODES.map((m) => ({ value: m, label: RUNTIME_MODE_LABELS[m], title: RUNTIME_MODE_HINTS[m] })),
];
const INTERACTION_OPTIONS: SelectOption<InteractionMode>[] = INTERACTION_MODES.map((m) => ({
  value: m,
  label: INTERACTION_LABELS[m],
}));
const WORKTREE_OPTIONS: SelectOption<"own" | "inherit">[] = [
  { value: "own", label: "Own worktree" },
  { value: "inherit", label: "Inherit a checkout" },
];

function StageEditor({
  index,
  stage,
  earlier,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  stage: StageDraft;
  earlier: StageDraft[];
  count: number;
  onChange: (patch: Partial<StageDraft>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const donors: SelectOption<string>[] = earlier.map((s, i) => ({ value: s.uid, label: `${i + 1}. ${s.role.trim() || "(no role)"}` }));
  const donor =
    stage.inheritUid !== "" && earlier.some((s) => s.uid === stage.inheritUid) ? stage.inheritUid : (earlier.at(-1)?.uid ?? "");
  return (
    <StageCard
      marker={stageMarker(index)}
      tone={index === 0 ? "lead" : "stage"}
      label={`Stage ${n}`}
      subject={`stage ${n}`}
      title={
        <StageTitleInput
          ariaLabel={`Stage ${n} role`}
          placeholder={index === 0 ? "planner" : "implementer, reviewer…"}
          value={stage.role}
          onChange={(role) => onChange({ role })}
        />
      }
      harness={
        <HarnessFields
          layout="inline"
          name={`Stage ${n}`}
          provider={stage.provider}
          model={stage.model}
          onChange={(patch) =>
            onChange({
              ...(patch.provider === undefined ? {} : { provider: patch.provider }),
              ...(patch.model === undefined ? {} : { model: patch.model }),
            })
          }
        />
      }
      onMove={onMove}
      canMoveUp={index > 0}
      canMoveDown={index < count - 1}
      onRemove={onRemove}
      canRemove={count > 1}
    >
      <StageSettings>
        <StageSetting label="Permissions">
          <Select label={`Stage ${n} permissions`} value={stage.mode} options={MODE_OPTIONS} onSelect={(mode) => onChange({ mode })} variant="field" size="md" />
        </StageSetting>
        <StageSetting label="Mode">
          <Select label={`Stage ${n} interaction`} value={stage.interaction} options={INTERACTION_OPTIONS} onSelect={(interaction) => onChange({ interaction })} variant="field" size="md" />
        </StageSetting>
        {index === 0 ? (
          <StageSetting label="Checkout">
            <StageSettingText>Its own, as the lead</StageSettingText>
          </StageSetting>
        ) : (
          <StageSetting label="Checkout">
            <Select label={`Stage ${n} worktree`} value={stage.worktree} options={WORKTREE_OPTIONS} onSelect={(worktree) => onChange({ worktree })} variant="field" size="md" />
          </StageSetting>
        )}
        {index > 0 && stage.worktree === "inherit" ? (
          <StageSetting label="From stage">
            <Select label={`Stage ${n} inherits from`} value={donor} options={donors} onSelect={(inheritUid) => onChange({ inheritUid })} variant="field" size="md" />
          </StageSetting>
        ) : null}
      </StageSettings>
      <StageNote
        label="Instructions"
        ariaLabel={`Stage ${n} instructions`}
        hint="What this stage must hand over and when it is done. The task and earlier stages' results are passed in for you."
        placeholder={
          index === 0
            ? "Break the task into steps, then delegate each later stage with what it needs."
            : "Take the previous stage's result and …; stop when …"
        }
        emptySummary="None — the role and task are enough"
        value={stage.instructions}
        onChange={(instructions) => onChange({ instructions })}
      />
    </StageCard>
  );
}

/** Add / edit one team: name and an ordered list of stages. */
export function TeamDialog({ team, onSubmit, onCancel }: { team?: Team; onSubmit: (team: Team) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<TeamDraft>(() => draftFromTeam(team));
  const patchStage = (uid: string, patch: Partial<StageDraft>): void =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) }));
  const move = (index: number, delta: -1 | 1): void =>
    setDraft((d) => {
      const stages = [...d.stages];
      const [moved] = stages.splice(index, 1);
      if (moved) stages.splice(index + delta, 0, moved);
      return { ...d, stages };
    });
  const result = teamFromDraft(draft);
  const submit = (): void => {
    if ("team" in result) onSubmit(result.team);
  };
  const n = draft.stages.length;
  return (
    <Dialog title={team ? "Edit team" : "New team"} onCancel={onCancel} variant="sheet">
      <DialogFrame
        heading={n === 1 ? "Run one stage on its own harness" : `Run ${n} stages in sequence, each on its own harness`}
        context={team ? `Editing “${team.name}”` : "Saved teams appear under New thread › Team."}
        outcome="Stage 1 leads the run in a new thread and delegates each later stage to its harness, in this order."
        primaryLabel="Save team"
        onPrimary={submit}
        blockedReason={"error" in result ? result.error : undefined}
        onCancel={onCancel}
      >
        <PrimaryField
          label="Name"
          ariaLabel="Team name"
          placeholder="Plan, build, review"
          value={draft.name}
          onChange={(name) => setDraft((d) => ({ ...d, name }))}
        />
        <FrameSection title="Stages" aside={`${n} of ${MAX_STAGES}`}>
          <StageList
            label="Stages"
            add={{
              label: "Add a stage",
              hint: n >= MAX_STAGES ? `a team has at most ${MAX_STAGES}` : "runs after the ones above",
              disabled: n >= MAX_STAGES,
              onClick: () => setDraft((d) => ({ ...d, stages: [...d.stages, blankStage()] })),
            }}
          >
            {draft.stages.map((s, i) => (
              <StageEditor
                key={s.uid}
                index={i}
                stage={s}
                earlier={draft.stages.slice(0, i)}
                count={n}
                onChange={(patch) => patchStage(s.uid, patch)}
                onMove={(delta) => move(i, delta)}
                onRemove={() => setDraft((d) => ({ ...d, stages: d.stages.filter((x) => x.uid !== s.uid) }))}
              />
            ))}
          </StageList>
        </FrameSection>
      </DialogFrame>
    </Dialog>
  );
}
