import { useMemo, useState } from "react";
import { selectRepoSiblings } from "@tide/client";
import { repoDisplayName, type Project, type ReadModel, type RepoIdentity, type UserSettings } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { envOfProject, environmentName, useEnvironments } from "../../state/environments.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { connectedEnvs } from "../fleet/envView.ts";

/** Where `project.ensure` clones when a machine has no `environment.projectsDir`. */
export const DEFAULT_PROJECTS_DIR = "~/tide-projects";

/**
 * What creating the thread on `target` means: the project's own checkout, another clone of the
 * same repo that machine already has, or a fresh clone there.
 */
export type RunOnPlan =
  | { kind: "own" }
  | { kind: "sibling"; project: Project }
  | { kind: "clone"; repo: RepoIdentity; projectsDir?: string };

/** Pure: the plan for one target. `ownerOf` maps a project id to its machine. */
export function planRunOn(input: {
  project: Project;
  siblings: readonly Project[];
  owner: string | undefined;
  target: string | undefined;
  ownerOf: (projectId: string) => string | undefined;
  /** the target machine's projects folder once its settings are loaded; undefined = not known */
  projectsDir?: string | undefined;
}): RunOnPlan {
  const { project, target } = input;
  if (target === undefined || target === input.owner || project.repo === undefined) return { kind: "own" };
  const sibling = input.siblings.find((p) => input.ownerOf(p.id) === target);
  if (sibling !== undefined) return { kind: "sibling", project: sibling };
  return { kind: "clone", repo: project.repo, ...(input.projectsDir === undefined ? {} : { projectsDir: input.projectsDir }) };
}

/** The picker's caption and, for a clone, the second line. */
export function runOnCaption(plan: RunOnPlan, machine: string): { caption: string; note?: string } {
  switch (plan.kind) {
    case "own":
      return { caption: "Runs on this machine's checkout" };
    case "sibling":
      return { caption: `Uses ${plan.project.title} on ${machine}` };
    case "clone":
      return {
        caption: `Clones ${repoDisplayName(plan.repo.remoteUrl)} onto ${machine}${plan.projectsDir === undefined ? "" : ` into ${plan.projectsDir}`}`,
        note: "Linked repositories are not carried over",
      };
  }
}

type ServerSettingsState = ReturnType<typeof useServerSettings.getState>;

/** One machine's settings as this window last read them; undefined until they have loaded. */
export function settingsOfEnv(state: ServerSettingsState, envId: string | undefined, primaryId: string | undefined): UserSettings | undefined {
  if (envId === undefined || envId === primaryId) return state.loaded ? state.settings : undefined;
  const entry = state.byEnv[envId];
  return entry?.loaded === true ? entry.settings : undefined;
}

export interface RunOn {
  /** the picker shows: the project knows its repo and two or more machines are connected */
  pickable: boolean;
  owner: string | undefined;
  target: string | undefined;
  setTarget: (envId: string) => void;
  plan: RunOnPlan;
  machine: string;
  caption: string;
  note?: string;
}

const siblingsOf = (model: ReadModel, projectId: string | undefined): Project[] =>
  projectId === undefined ? [] : selectRepoSiblings(model, projectId);

/** "Run on <machine>" for the new-thread form. */
export function useRunOn(projectId: string | undefined): RunOn {
  const model = useModel((s) => s.model);
  const project = projectId === undefined ? undefined : model.projects[projectId];
  const owner = projectId === undefined ? undefined : envOfProject(projectId);
  const connected = useEnvironments((s) => connectedEnvs(s).length);
  const primaryId = useEnvironments((s) => s.primaryId);
  const [chosen, setTarget] = useState<string | undefined>(undefined);
  const pickable = project?.repo !== undefined && connected >= 2;
  const target = pickable ? (chosen ?? owner) : owner;
  const projectsDir = useServerSettings((s) => {
    const settings = settingsOfEnv(s, target, primaryId);
    return settings === undefined ? undefined : (settings.environment.projectsDir ?? DEFAULT_PROJECTS_DIR);
  });
  const siblings = useMemo(() => siblingsOf(model, projectId), [model, projectId]);
  const plan: RunOnPlan =
    project === undefined ? { kind: "own" } : planRunOn({ project, siblings, owner, target, ownerOf: envOfProject, projectsDir });
  const machine = environmentName(target);
  return { pickable, owner, target, setTarget, plan, machine, ...runOnCaption(plan, machine) };
}
