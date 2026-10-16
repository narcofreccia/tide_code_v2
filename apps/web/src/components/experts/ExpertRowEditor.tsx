import type { ProviderKind } from "@tide/contracts";
import { presetByKey } from "../../lib/expertPresets.ts";
import { HarnessFields } from "../thread/ProviderPicker.tsx";
import { StageCard, stageMarker, StageSubtitleInput, StageTitleInput } from "../ui/StageList/StageCard.tsx";
import { StageNote } from "../ui/StageList/StageNote.tsx";

/** One editable seat before the session exists. `key` is stable per row. */
export interface ExpertDraft {
  key: string;
  name: string;
  role: string;
  provider: ProviderKind;
  /** empty means "let the harness choose" */
  model: string;
  /** empty means "the preset's persona" (or the server default for a blank seat) */
  persona: string;
  /** the preset this seat came from, whose persona is the default */
  presetKey?: string;
}

const BLANK_PERSONA =
  "You are the … on this panel. Say what you look for, what you ignore, and what a good answer from you contains.";

/** The persona that is sent when the field is left empty. */
export function defaultPersona(expert: ExpertDraft): string {
  return expert.presetKey === undefined ? "" : (presetByKey(expert.presetKey)?.persona ?? "");
}

export function ExpertRowEditor({
  expert,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  expert: ExpertDraft;
  index: number;
  count: number;
  onChange: (patch: Partial<ExpertDraft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const fallback = defaultPersona(expert);
  return (
    <StageCard
      marker={stageMarker(index)}
      label={`Expert ${n}`}
      subject={expert.name.trim() || `expert ${n}`}
      title={
        <StageTitleInput
          ariaLabel={`Expert ${n} name`}
          placeholder="Name this expert"
          value={expert.name}
          onChange={(name) => onChange({ name })}
        />
      }
      subtitle={
        <StageSubtitleInput
          ariaLabel={`Expert ${n} role`}
          placeholder="What it focuses on"
          value={expert.role}
          onChange={(role) => onChange({ role })}
        />
      }
      harness={
        <HarnessFields
          layout="inline"
          name={`Expert ${n}`}
          provider={expert.provider}
          model={expert.model}
          onChange={(patch) =>
            onChange({
              ...(patch.provider === undefined ? {} : { provider: patch.provider }),
              ...(patch.model === undefined ? {} : { model: patch.model }),
            })
          }
        />
      }
      onMove={(delta) => onMove(index + delta)}
      canMoveUp={index > 0}
      canMoveDown={index < count - 1}
      onRemove={onRemove}
    >
      <StageNote
        label="Persona"
        ariaLabel={`Expert ${n} persona`}
        hint="A good persona names the angle, what to look for in this codebase, and what to leave to the others. Leave it empty to use the default."
        placeholder={fallback || BLANK_PERSONA}
        emptySummary={fallback === "" ? "Harness default" : "Default for this role"}
        value={expert.persona}
        onChange={(persona) => onChange({ persona })}
      />
    </StageCard>
  );
}
