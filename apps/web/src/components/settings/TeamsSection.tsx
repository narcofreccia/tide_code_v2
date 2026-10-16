import { useState } from "react";
import type { Team } from "@tide/contracts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { saveTeams, stageLabel } from "../../lib/teamActions.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { TeamDialog } from "./TeamDialog.tsx";
import { duplicateTeam } from "./teamDraft.ts";
import styles from "./Teams.module.css";
import section from "./Section.module.css";

type Editing = { team?: Team } | null;

/** Settings › Teams: saved stage pipelines that "Start team run" offers. */
export function TeamsSection() {
  const teams = useServerSettings((s) => s.settings.teams);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [resetting, setResetting] = useState(false);

  const save = (next: Team[]): void => runOrToast("Saving teams", () => saveTeams(next));
  const submit = (team: Team): void => {
    const known = teams.some((t) => t.id === team.id);
    setEditing(null);
    save(known ? teams.map((t) => (t.id === team.id ? team : t)) : [...teams, team]);
  };

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Teams</h3>
        <div className={styles.actions}>
          <Button variant="quiet" onClick={() => setResetting(true)}>Reset to presets</Button>
          <Button variant="primary" onClick={() => setEditing({})}>New team</Button>
        </div>
      </div>
      <p className={section.note}>
        A team is an ordered list of roles on chosen harnesses. Stage 1 leads and delegates the later stages, each in its own
        worktree or in an earlier stage’s checkout. Start one from New thread › Team.
      </p>
      {teams.length === 0 ? (
        <p className={section.note}>No teams saved. The presets are offered until you save one.</p>
      ) : (
        <ul className={section.rows}>
          {teams.map((team) => (
            <li key={team.id} className={`${section.row} ${styles.item}`}>
              <div className={styles.top}>
                <span className={styles.name}>{team.name}</span>
                <div className={styles.actions}>
                  <Button onClick={() => setEditing({ team })}>Edit</Button>
                  <Button variant="quiet" onClick={() => save([...teams, duplicateTeam(team)])}>Duplicate</Button>
                  <Button variant="quiet" onClick={() => setDeleting(team)}>Delete</Button>
                </div>
              </div>
              <div className={styles.stages}>
                {team.stages.map((stage, i) => (
                  <span key={stage.key}>{i > 0 ? "→ " : ""}{stageLabel(stage)}</span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? <TeamDialog {...(editing.team ? { team: editing.team } : {})} onSubmit={submit} onCancel={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete team"
          body={<>Delete <strong>{deleting.name}</strong>? Runs already started keep their copy.</>}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const gone = deleting;
            setDeleting(null);
            save(teams.filter((t) => t.id !== gone.id));
          }}
        />
      ) : null}
      {resetting ? (
        <ConfirmDialog
          title="Reset teams"
          body="Replace your teams with the shipped presets?"
          confirmLabel="Reset"
          onCancel={() => setResetting(false)}
          onConfirm={() => {
            setResetting(false);
            save([]);
          }}
        />
      ) : null}
    </div>
  );
}
