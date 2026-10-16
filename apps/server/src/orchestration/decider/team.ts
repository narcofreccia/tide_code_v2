import type { CommandOf, ReadModel, Thread } from "@tide/contracts";
import { teamBrief } from "../../experts/prompts.ts";
import { stageSources } from "../../teams/stages.ts";
import { fail, isArchived, ok, providerDefault, turnRequested, type DecideContext, type DecideResult } from "./types.ts";

const TITLE_TASK_MAX = 50;

/** "<team>: <first line of the task, at most 50 characters>" */
export function teamRunTitle(teamName: string, task: string): string {
  const first = (task.split("\n").find((line) => line.trim() !== "") ?? task).trim();
  const short = first.length > TITLE_TASK_MAX ? `${first.slice(0, TITLE_TASK_MAX - 1).trimEnd()}…` : first;
  return `${teamName}: ${short}`;
}

/**
 * `team.run`: creates the lead thread (stage 1) with the team copied onto it and seeds it with
 * the brief. The server never runs the later stages — the lead delegates them through
 * `tide_delegate`, so every stage is an ordinary delegate thread of the lead.
 */
export function decideTeam(model: ReadModel, command: CommandOf<"team.run">, ctx: DecideContext): DecideResult {
  const project = model.projects[command.projectId];
  if (!project) return fail("not-found", `unknown project ${command.projectId}`);
  if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);
  const { team } = command;
  const lead = team.stages[0];
  if (lead === undefined) return fail("invalid-command", `team ${team.name} has no stages`);
  const resolved = stageSources(team);
  if ("error" in resolved) return fail("invalid-command", resolved.error);

  const defaults = providerDefault(ctx, lead.provider);
  const leadModel = lead.model ?? defaults.model;
  const thread: Thread = {
    id: ctx.newId(),
    projectId: project.id,
    title: command.title ?? teamRunTitle(team.name, command.task),
    provider: lead.provider,
    ...(leadModel !== undefined ? { model: leadModel } : {}),
    mode: lead.mode ?? defaults.mode ?? "approval-required",
    interaction: lead.interaction ?? "default",
    status: "idle",
    team: { name: team.name, stages: team.stages },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  return ok(
    { type: "thread.created", thread, useWorktree: command.useWorktree ?? ctx.worktreeByDefault ?? true },
    turnRequested(thread.id, teamBrief(team, command.task, thread.id), ctx),
  );
}
