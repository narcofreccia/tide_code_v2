import { useState } from "react";
import type { Team } from "@tide/contracts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { saveTeams, stageLabel } from "../../lib/teamActions.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { TeamDialog } from "./TeamDialog.tsx";
import { duplicateTeam } from "./teamDraft.ts";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import styles from "./Rows.module.css";

type Editing = { team?: Team } | null;

export const META: SectionMeta = {
  title: "Teams",
  blurb:
    "A team is an ordered list of roles on chosen harnesses. Stage 1 leads and delegates the later stages, each in its own worktree or in an earlier stage’s checkout.",
  keywords: ["New team", "Reset to presets", "stages", "roles", "pipeline"],
};

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
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup
        title="Teams"
        help="Start one from New thread › Team."
        actions={
          <>
            <Button variant="quiet" onClick={() => setResetting(true)}>Reset to presets</Button>
            <Button variant="primary" onClick={() => setEditing({})}>New team</Button>
          </>
        }
      >
        {teams.length === 0 ? (
          <SettingNote>No teams saved. The presets are offered until you save one.</SettingNote>
        ) : (
          teams.map((team) => (
            <SettingRow
              key={team.id}
              id={`setting-team-${team.id}`}
              label={<span className={styles.name}>{team.name}</span>}
              help={
                <span className={styles.meta}>
                  {team.stages.map((stage, i) => (
                    <span key={stage.key}>{i > 0 ? "→ " : ""}{stageLabel(stage)}</span>
                  ))}
                </span>
              }
              control={
                <>
                  <Button onClick={() => setEditing({ team })}>Edit</Button>
                  <Button variant="quiet" onClick={() => save([...teams, duplicateTeam(team)])}>Duplicate</Button>
                  <Button variant="quietDanger" onClick={() => setDeleting(team)}>Delete</Button>
                </>
              }
            />
          ))
        )}
      </SettingsGroup>
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
    </SettingsPage>
  );
}
