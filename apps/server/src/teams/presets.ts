import type { Team } from "@tide/contracts";

/**
 * Teams shown when the user has saved none of their own: `settings.get` returns these while the
 * stored list is empty, and `settings.set { teams: [] }` brings them back. Each stage runs on the
 * harness's own default model unless the user edits the team.
 */
export const PRESET_TEAMS: readonly Team[] = [
  {
    id: "preset-plan-build-review",
    name: "Plan → Build → Review",
    stages: [
      { key: "lead", role: "planner", provider: "claude", worktree: "own" },
      { key: "build", role: "implementer", provider: "codex", worktree: "own" },
      { key: "review", role: "reviewer", provider: "opencode", worktree: "inherit", inheritFrom: "build" },
    ],
  },
  {
    id: "preset-build-test",
    name: "Build → Test",
    stages: [
      { key: "build", role: "implementer", provider: "codex", worktree: "own" },
      { key: "test", role: "tester", provider: "claude", worktree: "inherit", inheritFrom: "build" },
    ],
  },
  {
    id: "preset-pair-review",
    name: "Pair review",
    stages: [
      { key: "build", role: "implementer", provider: "claude", worktree: "own" },
      { key: "review", role: "reviewer", provider: "codex", worktree: "inherit", inheritFrom: "build" },
    ],
  },
];

/** A fresh copy, so callers can never mutate the presets. */
export function presetTeams(): Team[] {
  return structuredClone(PRESET_TEAMS) as Team[];
}
