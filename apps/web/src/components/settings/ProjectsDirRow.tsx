import { useState } from "react";
import { useEnvironments } from "../../state/environments.ts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { EnvSelect } from "../fleet/EnvSelect.tsx";
import { DEFAULT_PROJECTS_DIR, settingsOfEnv } from "../shell/useRunOn.ts";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingText } from "./ui/SettingText.tsx";

const ABSOLUTE = /^(~$|~\/|\/|[A-Za-z]:[\\/])/;

/** "~/code", "/srv/repos" or "C:\\repos"; empty restores the default. */
export function validateProjectsDir(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" || ABSOLUTE.test(trimmed) ? undefined : "Use an absolute path (or one starting with ~/)";
}

/**
 * R17 B3: per machine, the folder `project.ensure` clones into when a thread is started there on a
 * repo that machine has no checkout of. The machine picker shows only with two or more connected.
 */
export function ProjectsDirGroup() {
  const primaryId = useEnvironments((s) => s.primaryId);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const envId = chosen ?? primaryId;
  const value = useServerSettings((s) => settingsOfEnv(s, envId, primaryId)?.environment.projectsDir ?? "");
  const commit = (next: string): Promise<void> => {
    const trimmed = next.trim();
    return patchServerSettings({ environment: { projectsDir: trimmed === "" ? null : trimmed } }, envId === primaryId ? undefined : envId);
  };
  return (
    <SettingsGroup title="Cloned repositories" actions={<EnvSelect label="Machine" value={envId} onSelect={setChosen} />}>
      <SettingRow
        label="Projects folder"
        help={`Where repos from other machines are cloned when you start a thread here. Empty uses ${DEFAULT_PROJECTS_DIR}.`}
        control={(id) => (
          <SettingText id={id} label="Projects folder" mono placeholder={DEFAULT_PROJECTS_DIR} value={value} validate={validateProjectsDir} onCommit={commit} />
        )}
      />
    </SettingsGroup>
  );
}
