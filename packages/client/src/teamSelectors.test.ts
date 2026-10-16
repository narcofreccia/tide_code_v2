import { describe, expect, it } from "vitest";
import { emptyReadModel, type Thread, type TeamStage } from "@tide/contracts";
import { selectTeamStages } from "./selectors.ts";

const stage = (role: string, provider: TeamStage["provider"] = "claude"): TeamStage => ({
  key: role,
  role,
  provider,
  worktree: "own",
});

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p1",
    title: id,
    provider: "claude",
    mode: "approval-required",
    interaction: "default",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("selectTeamStages", () => {
  const team = { name: "Ship", stages: [stage("planner"), stage("implementer", "codex"), stage("reviewer")] };

  it("returns nothing for a thread that leads no team", () => {
    const model = { ...emptyReadModel(), threads: { l: thread("l") } };
    expect(selectTeamStages(model, "l")).toEqual([]);
  });

  it("maps the lead to stage 1 and missing delegates to pending", () => {
    const model = { ...emptyReadModel(), threads: { l: thread("l", { team, status: "running" }) } };
    const stages = selectTeamStages(model, "l");
    expect(stages.map((s) => s.status)).toEqual(["running", "pending", "pending"]);
    expect(stages[0]?.thread?.id).toBe("l");
  });

  it("matches delegates by role, takes the latest, and maps their state", () => {
    const model = {
      ...emptyReadModel(),
      threads: {
        l: thread("l", { team }),
        old: thread("old", { delegatedBy: "l", delegateRole: "implementer", status: "error", createdAt: 2 }),
        impl: thread("impl", { delegatedBy: "l", delegateRole: "implementer", status: "idle", createdAt: 3 }),
        rev: thread("rev", { delegatedBy: "l", delegateRole: "reviewer", status: "running", createdAt: 4, attention: "approval" as never }),
        other: thread("other", { delegatedBy: "x", delegateRole: "reviewer", createdAt: 5 }),
      },
    };
    const stages = selectTeamStages(model, "l");
    expect(stages.map((s) => s.thread?.id)).toEqual(["l", "impl", "rev"]);
    expect(stages.map((s) => s.status)).toEqual(["done", "done", "needs-you"]);
  });
});
