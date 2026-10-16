import { useState } from "react";
import type { InteractionMode, RuntimeMode, Team } from "@tide/contracts";
import { INTERACTION_LABELS, INTERACTION_MODES, RUNTIME_MODE_LABELS, RUNTIME_MODES } from "../../lib/vocab.ts";
import { HarnessFields } from "../thread/ProviderPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { MAX_STAGES, blankStage, draftFromTeam, teamFromDraft, type StageDraft, type TeamDraft } from "./teamDraft.ts";
import styles from "./Teams.module.css";

const MODE_OPTIONS: SelectOption<RuntimeMode | "">[] = [
  { value: "", label: "Harness default" },
  ...RUNTIME_MODES.map((m) => ({ value: m, label: RUNTIME_MODE_LABELS[m] })),
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
  const donor = stage.inheritUid !== "" && earlier.some((s) => s.uid === stage.inheritUid) ? stage.inheritUid : (earlier.at(-1)?.uid ?? "");
  return (
    <li className={styles.stage} aria-label={`Stage ${n}`}>
      <div className={styles.stageHead}>
        <span className={styles.stageNo}>Stage {n}{index === 0 ? " · lead" : ""}</span>
        <Button variant="quiet" disabled={index === 0} aria-label={`Move stage ${n} up`} onClick={() => onMove(-1)}>↑</Button>
        <Button variant="quiet" disabled={index === count - 1} aria-label={`Move stage ${n} down`} onClick={() => onMove(1)}>↓</Button>
        <Button variant="quiet" disabled={count === 1} aria-label={`Remove stage ${n}`} onClick={onRemove}>×</Button>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>Role</span>
        <input className={styles.input} aria-label={`Stage ${n} role`} placeholder="planner, implementer, reviewer…" value={stage.role} onChange={(e) => onChange({ role: e.target.value })} />
      </label>
      <HarnessFields
        name={`Stage ${n}`}
        provider={stage.provider}
        model={stage.model}
        onChange={(patch) => onChange({ ...(patch.provider === undefined ? {} : { provider: patch.provider }), ...(patch.model === undefined ? {} : { model: patch.model }) })}
      />
      <div className={styles.row}>
        <Select label={`Stage ${n} permissions`} value={stage.mode} options={MODE_OPTIONS} onSelect={(mode) => onChange({ mode })} variant="field" size="md" />
        <Select label={`Stage ${n} interaction`} value={stage.interaction} options={INTERACTION_OPTIONS} onSelect={(interaction) => onChange({ interaction })} variant="field" size="md" />
      </div>
      {index > 0 ? (
        <div className={styles.row}>
          <Select label={`Stage ${n} worktree`} value={stage.worktree} options={WORKTREE_OPTIONS} onSelect={(worktree) => onChange({ worktree })} variant="field" size="md" />
          {stage.worktree === "inherit" ? (
            <Select label={`Stage ${n} inherits from`} value={donor} options={donors} onSelect={(inheritUid) => onChange({ inheritUid })} variant="field" size="md" />
          ) : null}
        </div>
      ) : null}
      <label className={styles.field}>
        <span className={styles.label}>Instructions</span>
        <textarea className={styles.text} aria-label={`Stage ${n} instructions`} value={stage.instructions} onChange={(e) => onChange({ instructions: e.target.value })} />
      </label>
    </li>
  );
}

/** Add / edit one team: name and an ordered list of stages. */
export function TeamDialog({ team, onSubmit, onCancel }: { team?: Team; onSubmit: (team: Team) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<TeamDraft>(() => draftFromTeam(team));
  const [error, setError] = useState<string | null>(null);
  const patchStage = (uid: string, patch: Partial<StageDraft>): void =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) }));
  const move = (index: number, delta: -1 | 1): void =>
    setDraft((d) => {
      const stages = [...d.stages];
      const [moved] = stages.splice(index, 1);
      if (moved) stages.splice(index + delta, 0, moved);
      return { ...d, stages };
    });
  const submit = (): void => {
    const result = teamFromDraft(draft);
    if ("error" in result) return setError(result.error);
    onSubmit(result.team);
  };
  return (
    <Dialog title={team ? "Edit team" : "New team"} onCancel={onCancel}>
      <div className={styles.dialog}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input className={styles.input} aria-label="Team name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <ol className={styles.stageList} aria-label="Stages">
          {draft.stages.map((s, i) => (
            <StageEditor
              key={s.uid}
              index={i}
              stage={s}
              earlier={draft.stages.slice(0, i)}
              count={draft.stages.length}
              onChange={(patch) => patchStage(s.uid, patch)}
              onMove={(delta) => move(i, delta)}
              onRemove={() => setDraft((d) => ({ ...d, stages: d.stages.filter((x) => x.uid !== s.uid) }))}
            />
          ))}
        </ol>
        <div>
          <Button disabled={draft.stages.length >= MAX_STAGES} onClick={() => setDraft((d) => ({ ...d, stages: [...d.stages, blankStage()] }))}>
            Add stage
          </Button>
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
      <div className={styles.footer}>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={submit}>Save</Button>
      </div>
    </Dialog>
  );
}
