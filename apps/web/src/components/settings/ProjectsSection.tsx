import { useState } from "react";
import { selectProjects, selectThreadsByProject } from "@tide/client";
import type { Project } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useMultiEnv } from "../fleet/envView.ts";
import { AddProjectForm } from "../shell/AddProjectForm.tsx";
import { ProjectIconDialog } from "../shell/ProjectDialogs.tsx";
import { Button } from "../ui/Button.tsx";
import { ArchivedProjectRow, ProjectRow } from "./ProjectRows.tsx";
import { ProjectRunSection } from "./ProjectRunSection.tsx";
import type { SectionMeta } from "./search.ts";
import { SettingBlock, SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";

export const META: SectionMeta = {
  title: "Projects",
  blurb: "Repositories Tide knows on this machine. Archiving hides a project and its threads without deleting anything.",
  keywords: ["Add project", "Archived", "Restore", "Rename", "Icon", "Linked repositories", "Copy path", "Archive", "repository", "Run", "stack", "ports", "quickstart"],
};

/** Settings › Projects: every live project with its actions, Add project, and the archive. */
export function ProjectsSection() {
  const model = useModel((s) => s.model);
  const multiEnv = useMultiEnv();
  const [adding, setAdding] = useState(false);
  const [iconFor, setIconFor] = useState<string | null>(null);
  const [runFor, setRunFor] = useState<string | null>(null);
  const live = selectProjects(model);
  const archived = Object.values(model.projects)
    .filter((p): p is Project & { archivedAt: number } => p.archivedAt !== undefined)
    .sort((a, b) => b.archivedAt - a.archivedAt || a.title.localeCompare(b.title));
  const allThreads = Object.values(model.threads);
  const iconProject = iconFor === null ? undefined : model.projects[iconFor];

  const runProject = runFor === null ? undefined : model.projects[runFor];
  if (runProject) return <ProjectRunSection project={runProject} onBack={() => setRunFor(null)} />;

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup title="Projects">
        {live.length === 0 ? <SettingNote>No projects yet. Add a repository below.</SettingNote> : null}
        {live.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            threads={selectThreadsByProject(model, project.id).length}
            multiEnv={multiEnv}
            onIcon={() => setIconFor(project.id)}
            onRun={() => setRunFor(project.id)}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Add project"
        help="Add a git repository that exists, or start a new one. A path that belongs to an archived project brings that project back."
        actions={
          adding ? undefined : (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add project…
            </Button>
          )
        }
      >
        {adding ? (
          <SettingBlock>
            <AddProjectForm onDone={() => setAdding(false)} />
          </SettingBlock>
        ) : null}
      </SettingsGroup>

      {archived.length > 0 ? (
        <SettingsGroup title={`Archived · ${archived.length}`} label="Archived projects" collapsible>
          {archived.map((project) => (
            <ArchivedProjectRow
              key={project.id}
              project={project}
              threads={allThreads.filter((t) => t.projectId === project.id).length}
            />
          ))}
        </SettingsGroup>
      ) : null}

      {iconProject ? <ProjectIconDialog project={iconProject} onClose={() => setIconFor(null)} /> : null}
    </SettingsPage>
  );
}
