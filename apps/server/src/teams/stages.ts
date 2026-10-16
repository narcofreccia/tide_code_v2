import type { Team } from "@tide/contracts";

/**
 * For each stage, the index of the stage whose worktree it runs in (`inherit`), or undefined
 * for a stage with its own. `inheritFrom` names an earlier stage by key; without it a stage
 * inherits from the previous one. Stage 1 (the lead) cannot inherit. Pure; returns an error
 * message instead of throwing so the decider can refuse with `invalid-command`.
 */
export function stageSources(team: Pick<Team, "stages">): { sources: (number | undefined)[] } | { error: string } {
  const sources: (number | undefined)[] = [];
  const seen = new Set<string>();
  for (const [index, stage] of team.stages.entries()) {
    if (seen.has(stage.key)) return { error: `stage key "${stage.key}" is used twice` };
    if (stage.worktree !== "inherit") {
      sources.push(undefined);
    } else if (index === 0) {
      return { error: `stage "${stage.key}" is the lead and cannot inherit a worktree` };
    } else if (stage.inheritFrom === undefined) {
      sources.push(index - 1);
    } else {
      const from = team.stages.findIndex((s) => s.key === stage.inheritFrom);
      if (from < 0 || from >= index) return { error: `stage "${stage.key}" inherits from "${stage.inheritFrom}", which is not an earlier stage` };
      sources.push(from);
    }
    seen.add(stage.key);
  }
  return { sources };
}
