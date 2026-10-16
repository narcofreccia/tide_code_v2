import { useMemo, useState } from "react";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { startTeamRun, teamOptionLabel, worktreeNote } from "../../lib/teamActions.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { worktreeByDefault, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./NewThreadPopover.module.css";

/** Team side of the new-thread form: pick a saved team, describe the task, start the run. */
export function NewTeamFields({ projectId, onDone }: { projectId: string | undefined; onDone: () => void }) {
  const teams = useServerSettings((s) => s.settings.teams);
  const [teamId, setTeamId] = useState<string>("");
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [useWorktree, setUseWorktree] = useState(worktreeByDefault);
  const team = teams.find((t) => t.id === teamId) ?? teams[0];
  const options = useMemo<SelectOption<string>[]>(
    () => teams.map((t) => ({ value: t.id, label: teamOptionLabel(t) })),
    [teams],
  );
  const ready = projectId !== undefined && team !== undefined && task.trim() !== "";
  const start = (): void => {
    if (!ready || team === undefined) return;
    const trimmed = title.trim();
    onDone();
    runOrToast("Starting the team run", () =>
      startTeamRun(projectId, team, task.trim(), { ...(trimmed === "" ? {} : { title: trimmed }), useWorktree }),
    );
  };
  if (team === undefined) {
    return <p className={styles.parent}>No teams yet. Add one in Settings › Teams.</p>;
  }
  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>team</span>
        <Select label="Team" value={team.id} options={options} onSelect={setTeamId} variant="field" size="md" />
      </div>
      <label className={styles.stack}>
        <span className={styles.label}>task</span>
        <textarea
          className={styles.textarea}
          aria-label="Task"
          placeholder="What should the team do?"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>title</span>
        <input
          className={styles.input}
          aria-label="Run title"
          placeholder="Auto from the task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <Checkbox checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)}>
        Use a worktree for the lead
      </Checkbox>
      <ol className={styles.stages} aria-label="Stages">
        {team.stages.map((stage, i) => (
          <li key={stage.key} className={styles.stageRow}>
            <span className={styles.stageRole}>{i + 1}. {stage.role}</span>
            <span className={styles.stageMeta}>{PROVIDER_LABELS[stage.provider]}</span>
            <span className={styles.stageMeta}>{worktreeNote(team.stages, i)}</span>
          </li>
        ))}
      </ol>
      <Button variant="primary" disabled={!ready} onClick={start}>
        Start team run
      </Button>
    </>
  );
}
