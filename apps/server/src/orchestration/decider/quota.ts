import type { CommandOf, Quota, QuotaState, ReadModel } from "@tide/contracts";
import { withReleases } from "./quotaGate.ts";
import { fail, ok, type DecideContext, type DecideResult } from "./types.ts";

type QuotaCommand = CommandOf<"quota.set"> | CommandOf<"quota.lift"> | CommandOf<"quota.meter"> | CommandOf<"usage.correct">;

/** How long `quota.lift` frees a scope whose cap has no window to wait for (the rolling USD cap). */
export const LIFT_WITHOUT_WINDOW_MS = 24 * 60 * 60_000;

function scopeOf(model: ReadModel, scope: "project" | "thread", id: string): { quota?: Quota; quotaState?: QuotaState } | undefined {
  return scope === "project" ? model.projects[id] : model.threads[id];
}

const sameQuota = (a: Quota | undefined, b: Quota | undefined): boolean =>
  a?.sharePct === b?.sharePct && a?.usdPerWeek === b?.usdPerWeek && a?.onExceed === b?.onExceed;

/**
 * R20: usage quotas and the cost repair. The hold itself is enforced in `decide()` (quotaGate.ts);
 * every quota change also releases the held queues it frees.
 */
export function decideQuota(model: ReadModel, command: QuotaCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "quota.set": {
      const entity = scopeOf(model, command.scope, command.id);
      if (!entity) return fail("not-found", `unknown ${command.scope} ${command.id}`);
      const quota = command.quota;
      if (quota !== undefined && quota.sharePct === undefined && quota.usdPerWeek === undefined) {
        return fail("invalid-command", "a quota needs a share of the weekly window, an amount per week, or both");
      }
      if (sameQuota(entity.quota, quota)) return ok(); // idempotent
      return withReleases(model, command.scope, command.id, ok({ type: "quota.changed", scope: command.scope, id: command.id, ...(quota !== undefined ? { quota } : {}), at: ctx.now }), ctx);
    }

    case "quota.lift": {
      const entity = scopeOf(model, command.scope, command.id);
      if (!entity) return fail("not-found", `unknown ${command.scope} ${command.id}`);
      const state = entity.quotaState;
      if (entity.quota === undefined || state?.status !== "exceeded") return fail("conflict", `the ${command.scope}'s quota is not holding anything`);
      const until = state.windowEndsAt !== undefined && state.windowEndsAt > ctx.now ? state.windowEndsAt : ctx.now + LIFT_WITHOUT_WINDOW_MS;
      return withReleases(model, command.scope, command.id, ok({ type: "quota.lifted", scope: command.scope, id: command.id, until, at: ctx.now }), ctx);
    }

    case "quota.meter": {
      const entity = scopeOf(model, command.scope, command.id);
      // the cap was removed (or its owner deleted) while the worker measured: nothing to record
      if (entity?.quota === undefined) return ok();
      // a lift the user gave outlives later measurements of the same window
      const lifted = entity.quotaState?.liftedUntil;
      const state: QuotaState = lifted !== undefined && lifted > ctx.now && command.state.liftedUntil === undefined ? { ...command.state, liftedUntil: lifted } : command.state;
      return withReleases(model, command.scope, command.id, ok({ type: "quota.metered", scope: command.scope, id: command.id, state }), ctx);
    }

    case "usage.correct": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (turn.usageCorrected === true) return fail("conflict", `turn ${turn.id} was already corrected`);
      return ok({ type: "usage.corrected", turnId: turn.id, threadId: turn.threadId, usage: command.usage, reason: command.reason, at: ctx.now });
    }
  }
}
