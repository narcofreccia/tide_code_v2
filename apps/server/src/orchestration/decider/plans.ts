import type { CommandOf, Message, ProposedPlan, ReadModel, Thread, Turn } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type PlanCommand =
  | CommandOf<"plan.propose">
  | CommandOf<"plan.progress">
  | CommandOf<"plan.implement">
  | CommandOf<"plan.dismiss">;

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/** Title for the implementation thread: the plan's first markdown heading. */
export function planTitle(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const match = HEADING.exec(line);
    const text = match?.[1]?.trim();
    if (text) return text;
  }
  return "Implement plan";
}

export function decidePlan(model: ReadModel, command: PlanCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "plan.propose": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      const plan: ProposedPlan = {
        id: ctx.newId(),
        threadId: turn.threadId,
        turnId: turn.id,
        markdown: command.markdown,
        status: "proposed",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok({ type: "plan.proposed", plan });
    }

    case "plan.progress": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      return ok({ type: "plan.progressed", threadId: thread.id, steps: command.steps, at: ctx.now });
    }

    case "plan.implement": {
      const plan = model.plans[command.planId];
      if (!plan) return fail("not-found", `unknown plan ${command.planId}`);
      if (plan.status !== "proposed") return fail("conflict", `plan ${plan.id} is already ${plan.status}`);
      const source = model.threads[plan.threadId];
      if (!source) return fail("not-found", `unknown thread ${plan.threadId}`);
      const project = model.projects[source.projectId];
      if (!project) return fail("not-found", `unknown project ${source.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);

      // A plan never runs in place: it seeds a sibling thread the user can steer.
      const thread: Thread = {
        id: ctx.newId(),
        projectId: source.projectId,
        parentThreadId: plan.threadId,
        title: planTitle(plan.markdown),
        provider: command.provider,
        ...(command.model !== undefined ? { model: command.model } : {}),
        mode: command.mode ?? "approval-required",
        interaction: "default",
        status: "idle",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      const turn: Turn = { id: ctx.newId(), threadId: thread.id, status: "requested", requestedAt: ctx.now };
      const userMessage: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: turn.id,
        role: "user",
        text: `Implement the following plan.\n\n${plan.markdown}`,
        createdAt: ctx.now,
      };
      return ok(
        { type: "thread.created", thread },
        { type: "turn.requested", turn, userMessage },
        { type: "plan.updated", planId: plan.id, status: "implemented", implementationThreadId: thread.id, at: ctx.now },
      );
    }

    case "plan.dismiss": {
      const plan = model.plans[command.planId];
      if (!plan) return fail("not-found", `unknown plan ${command.planId}`);
      if (plan.status === "dismissed") return ok(); // idempotent
      if (plan.status === "implemented") return fail("conflict", `plan ${plan.id} is already implemented`);
      return ok({ type: "plan.updated", planId: plan.id, status: "dismissed", at: ctx.now });
    }
  }
}
