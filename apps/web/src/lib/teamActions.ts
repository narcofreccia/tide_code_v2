import { newId, type Team, type TeamStage } from "@tide/contracts";
import { dispatch } from "../state/model.ts";
import { patchServerSettings } from "../state/serverSettings.ts";
import { PROVIDER_LABELS } from "./vocab.ts";
import { selectCreatedThread } from "./threadActions.ts";

export interface TeamRunOptions {
  title?: string;
  useWorktree?: boolean;
}

/** `team.run`: creates the lead thread and selects it. The server never runs stages itself. */
export async function startTeamRun(
  projectId: string,
  team: Team,
  task: string,
  options: TeamRunOptions = {},
): Promise<void> {
  const result = await dispatch({
    type: "team.run",
    commandId: newId(),
    projectId,
    team,
    task,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.useWorktree === undefined ? {} : { useWorktree: options.useWorktree }),
  });
  selectCreatedThread(result);
}

/** "planner (Claude)" */
export function stageLabel(stage: TeamStage): string {
  return `${stage.role} (${PROVIDER_LABELS[stage.provider]})`;
}

/** "Plan, build, review — planner (Claude) → implementer (Codex)" */
export function teamOptionLabel(team: Team): string {
  return `${team.name} — ${team.stages.map(stageLabel).join(" → ")}`;
}

/** Where stage `index` runs: its own checkout, or the checkout of the stage it inherits. */
export function worktreeNote(stages: readonly TeamStage[], index: number): string {
  const stage = stages[index];
  if (stage === undefined) return "";
  if (index === 0) return "the lead";
  if (stage.worktree === "own") return "own worktree";
  const from = stage.inheritFrom === undefined ? stages[index - 1] : stages.find((s) => s.key === stage.inheritFrom);
  return `runs in ${from?.role ?? "an earlier stage"}'s checkout`;
}

/** Saves the whole list; `[]` restores the shipped presets. */
export function saveTeams(teams: Team[]): Promise<void> {
  return patchServerSettings({ teams });
}

/** A key unique among `taken`, derived from the role ("Code Reviewer" → "code-reviewer", then "-2"). */
export function stageKey(role: string, taken: readonly string[]): string {
  const base = role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "stage";
  let key = base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}-${n}`;
  return key;
}
