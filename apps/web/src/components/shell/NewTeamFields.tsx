import { useState } from "react";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { startTeamRun, teamOptionLabel, worktreeNote } from "../../lib/teamActions.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { worktreeByDefault, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { Checkbox } from "../ui/Choice.tsx";
import { DialogFrame, FrameField, FrameSection, PrimaryField } from "../ui/DialogFrame.tsx";
import { PresetChips } from "../ui/StageList/PresetChips.tsx";
import { HarnessTag, StageCard, stageMarker, StageSubtitle, StageTitle } from "../ui/StageList/StageCard.tsx";
import { StageList } from "../ui/StageList/StageList.tsx";
import styles from "./NewThreadPopover.module.css";

function heading(stages: number): string {
  return stages === 1 ? "Run a one-stage team on its harness" : `Run ${stages} stages in sequence, each on its own harness`;
}

/** Team side of the new-thread form: pick a saved team, describe the task, start the run. */
export function NewTeamFields({
  projectId,
  onDone,
  toolbar,
}: {
  projectId: string | undefined;
  onDone: () => void;
  toolbar?: React.ReactNode;
}) {
  const teams = useServerSettings((s) => s.settings.teams);
  const [teamId, setTeamId] = useState<string>("");
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [useWorktree, setUseWorktree] = useState(worktreeByDefault);
  const team = teams.find((t) => t.id === teamId) ?? teams[0];
  const blocked =
    projectId === undefined
      ? "Add a project first"
      : team === undefined
        ? "Add a team in Settings › Teams"
        : task.trim() === ""
          ? "Describe the task to start"
          : undefined;
  const start = (): void => {
    if (blocked !== undefined || team === undefined || projectId === undefined) return;
    const trimmed = title.trim();
    onDone();
    runOrToast("Starting the team run", () =>
      startTeamRun(projectId, team, task.trim(), { ...(trimmed === "" ? {} : { title: trimmed }), useWorktree }),
    );
  };
  const editStages = (): void => {
    onDone();
    const ui = useUi.getState();
    ui.setSettingsSection("teams");
    ui.showSettings();
  };
  const lead = team?.stages[0];
  return (
    <DialogFrame
      heading={team === undefined ? "Run a team of harnesses on one task" : heading(team.stages.length)}
      {...(toolbar === undefined ? {} : { toolbar })}
      outcome={
        lead === undefined
          ? "A team needs at least one stage."
          : `Stage 1 (${lead.role}) leads in a new thread on ${PROVIDER_LABELS[lead.provider]} and hands each later stage to its harness in order.`
      }
      primaryLabel="Start team run"
      onPrimary={start}
      blockedReason={blocked}
      onCancel={onDone}
    >
      {team === undefined ? (
        <p className={styles.empty}>No teams yet. Add one in Settings › Teams.</p>
      ) : (
        <>
          <PrimaryField
            label="Task"
            ariaLabel="Task"
            multiline
            placeholder="Add rate limiting to the public API"
            value={task}
            onChange={setTask}
          />
          <FrameSection title="Team" aside={`${team.stages.length} ${team.stages.length === 1 ? "stage" : "stages"}`}>
            <PresetChips
              label="Teams"
              chips={teams.map((t) => ({ key: t.id, label: t.name, pressed: t.id === team.id, title: teamOptionLabel(t) }))}
              onToggle={setTeamId}
              kind="pick"
            />
            <StageList
              label="Stages"
              add={{ label: "Edit stages…", glyph: "✎", hint: "in Settings › Teams", onClick: editStages }}
            >
              {team.stages.map((stage, i) => (
                <StageCard
                  key={stage.key}
                  marker={stageMarker(i)}
                  tone={i === 0 ? "lead" : "stage"}
                  label={`Stage ${i + 1}`}
                  title={<StageTitle>{stage.role}</StageTitle>}
                  subtitle={<StageSubtitle>{worktreeNote(team.stages, i)}</StageSubtitle>}
                  harness={<HarnessTag provider={stage.provider} model={stage.model} />}
                />
              ))}
            </StageList>
          </FrameSection>
          <div className={styles.runRow}>
            <FrameField label="Run title" caption="Optional. Named from the task otherwise.">
              <input
                className={styles.input}
                aria-label="Run title"
                placeholder="Rate limiting"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </FrameField>
            <FrameField
              label="Checkout"
              caption="Later stages take their own worktree or an earlier stage's, as the team says."
            >
              <Checkbox className={styles.check} checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)}>
                Use a worktree for the lead
              </Checkbox>
            </FrameField>
          </div>
        </>
      )}
    </DialogFrame>
  );
}
