import { newId, type InteractionMode, type ProviderKind, type RuntimeMode, type Team, type TeamStage } from "@tide/contracts";
import { stageKey } from "../../lib/teamActions.ts";

/** A stage while editing: `uid` is stable across reordering, `inheritUid` points at the donor stage. */
export interface StageDraft {
  uid: string;
  role: string;
  provider: ProviderKind;
  model: string;
  mode: RuntimeMode | "";
  interaction: InteractionMode;
  worktree: "own" | "inherit";
  inheritUid: string;
  instructions: string;
}

export interface TeamDraft {
  id: string;
  name: string;
  stages: StageDraft[];
}

export const MAX_STAGES = 6;
let counter = 0;
export const nextUid = (): string => `s${(counter += 1)}`;

export function blankStage(): StageDraft {
  return {
    uid: nextUid(),
    role: "",
    provider: "claude",
    model: "",
    mode: "",
    interaction: "default",
    worktree: "own",
    inheritUid: "",
    instructions: "",
  };
}

export function draftFromTeam(team: Team | undefined): TeamDraft {
  if (team === undefined) return { id: newId(), name: "", stages: [blankStage()] };
  const uids = team.stages.map(() => nextUid());
  return {
    id: team.id,
    name: team.name,
    stages: team.stages.map((s, i) => {
      const from = s.inheritFrom === undefined ? i - 1 : team.stages.findIndex((x) => x.key === s.inheritFrom);
      return {
        uid: uids[i] ?? nextUid(),
        role: s.role,
        provider: s.provider,
        model: s.model ?? "",
        mode: s.mode ?? "",
        interaction: s.interaction ?? "default",
        worktree: i === 0 ? "own" : s.worktree,
        inheritUid: uids[from] ?? "",
        instructions: s.instructions ?? "",
      };
    }),
  };
}

export function duplicateTeam(team: Team): Team {
  return { ...team, id: newId(), name: `${team.name} copy`.slice(0, 80) };
}

/** First problem with the draft, or the team to save. Keys are generated from the roles. */
export function teamFromDraft(draft: TeamDraft): { error: string } | { team: Team } {
  const name = draft.name.trim();
  if (name === "") return { error: "Give the team a name." };
  if (draft.stages.length === 0) return { error: "A team needs at least one stage." };
  if (draft.stages.length > MAX_STAGES) return { error: `A team has at most ${MAX_STAGES} stages.` };
  const keys: string[] = [];
  const keyOf = new Map<string, string>();
  for (const s of draft.stages) {
    if (s.role.trim() === "") return { error: "Every stage needs a role." };
    const key = stageKey(s.role, keys);
    keys.push(key);
    keyOf.set(s.uid, key);
  }
  const stages: TeamStage[] = [];
  for (const [i, s] of draft.stages.entries()) {
    const key = keys[i] ?? "";
    let inheritFrom: string | undefined;
    if (i > 0 && s.worktree === "inherit") {
      const donorIndex = draft.stages.findIndex((x) => x.uid === s.inheritUid);
      if (donorIndex >= i) return { error: `“${s.role.trim()}” can only inherit from an earlier stage.` };
      inheritFrom = donorIndex < 0 ? keys[i - 1] : keyOf.get(s.inheritUid);
    }
    stages.push({
      key,
      role: s.role.trim(),
      provider: s.provider,
      ...(s.model === "" ? {} : { model: s.model }),
      ...(s.mode === "" ? {} : { mode: s.mode }),
      ...(s.interaction === "default" ? {} : { interaction: s.interaction }),
      worktree: i > 0 && s.worktree === "inherit" ? "inherit" : "own",
      ...(inheritFrom === undefined ? {} : { inheritFrom }),
      ...(s.instructions.trim() === "" ? {} : { instructions: s.instructions.trim() }),
    });
  }
  return { team: { id: draft.id, name, stages } };
}
