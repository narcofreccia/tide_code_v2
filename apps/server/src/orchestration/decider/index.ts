import type { Command, ReadModel } from "@tide/contracts";
import { decideActivity } from "./activities.ts";
import { decidePlan } from "./plans.ts";
import { decideProject } from "./projects.ts";
import { decideThread } from "./threads.ts";
import { decideTurn } from "./turns.ts";
import { fail, type DecideContext, type DecideResult } from "./types.ts";

export type { DecideContext, DecideError, DecideResult } from "./types.ts";
export { planTitle } from "./plans.ts";

/**
 * Pure decision function: (state, command) -> events | rejection.
 * Never touches the store, the clock or the id generator directly.
 */
export function decide(model: ReadModel, command: Command, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "project.create":
    case "project.update":
    case "project.archive":
      return decideProject(model, command, ctx);

    case "thread.create":
    case "thread.update":
    case "thread.archive":
      return decideThread(model, command, ctx);

    case "turn.request":
    case "turn.interrupt":
    case "turn.start":
    case "assistant.append":
    case "usage.report":
    case "turn.settle":
      return decideTurn(model, command, ctx);

    case "activity.upsert":
    case "approval.respond":
    case "user-input.respond":
      return decideActivity(model, command, ctx);

    case "plan.propose":
    case "plan.progress":
    case "plan.implement":
    case "plan.dismiss":
      return decidePlan(model, command, ctx);

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return fail("invalid-command", "unknown command type");
    }
  }
}
