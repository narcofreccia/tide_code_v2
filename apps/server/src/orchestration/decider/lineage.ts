import type { CommandOf, ReadModel, Thread, Turn, TurnStatus } from "@tide/contracts";
import { handoffTurns } from "../handoff/select.ts";
import { recordHandoff } from "./handoff.ts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type LineageCommand =
  | CommandOf<"thread.fork">
  | CommandOf<"thread.rollback">
  | CommandOf<"rollback.report">;

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);
const NEEDS_WORKTREE = "runs in the main checkout; restoring files requires a worktree";

/** `turn` and every later surviving turn of its thread, oldest first: what a rollback to `turn` undoes. */
export function rolledBackTurnIds(model: ReadModel, turn: Turn): string[] {
  return Object.values(model.turns)
    .filter((t) => t.threadId === turn.threadId && t.requestedAt >= turn.requestedAt && t.status !== "queued" && !t.rolledBack)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map((t) => t.id);
}

/** A thread's own settled, surviving turn, or the reason it is not one. */
function settledTurn(model: ReadModel, thread: Thread, turnId: string): { turn: Turn } | { code: string; message: string } {
  const turn = model.turns[turnId];
  if (!turn) return { code: "not-found", message: `unknown turn ${turnId}` };
  if (turn.threadId !== thread.id) return { code: "conflict", message: `turn ${turn.id} does not belong to thread ${thread.id}` };
  if (!SETTLED.has(turn.status)) return { code: "conflict", message: `turn ${turn.id} is ${turn.status}, not settled` };
  if (turn.rolledBack === true) return { code: "conflict", message: `turn ${turn.id} was rolled back` };
  return { turn };
}

/** Forking a thread at a settled turn and rolling one back to before a turn. */
export function decideLineage(model: ReadModel, command: LineageCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "thread.fork": {
      const source = model.threads[command.threadId];
      if (!source) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(source)) return fail("conflict", `thread ${source.id} is archived`);
      const found = settledTurn(model, source, command.turnId);
      if ("code" in found) return fail(found.code, found.message);
      const { turn } = found;
      const turns = handoffTurns(model, source.id, { untilTurnId: turn.id });
      if (turns.length === 0) return fail("conflict", "nothing to fork");
      const provider = command.provider ?? source.provider;
      const forkModel = command.model ?? (provider === source.provider ? source.model : undefined);
      const thread: Thread = {
        id: ctx.newId(),
        projectId: source.projectId,
        parentThreadId: source.id,
        forkedFrom: { threadId: source.id, turnId: turn.id },
        title: command.title ?? `${source.title} (fork)`,
        provider,
        ...(forkModel !== undefined ? { model: forkModel } : {}),
        mode: source.mode,
        interaction: source.interaction,
        ...(source.links !== undefined ? { links: source.links } : {}),
        status: "idle",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      // the fork continues the source's work: its worktree branches off the turn's after-state
      const baseRef = turn.checkpoint?.after ?? source.branch;
      // always recorded: the provider reactor marks it `native` when the harness forked its own
      // session, `inline` when the text had to be injected
      const handoff = recordHandoff(model, { threadId: thread.id, source, fromProvider: source.provider, toProvider: provider, strategy: "full", turns }, ctx);
      return ok(
        {
          type: "thread.created",
          thread,
          ...(command.useWorktree !== undefined ? { useWorktree: command.useWorktree } : {}),
          ...(baseRef !== undefined ? { baseRef } : {}),
        },
        handoff,
      );
    }

    case "thread.rollback": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      if (thread.rollback?.status === "rolling") return fail("busy", `thread ${thread.id} is already rolling back`);
      const found = settledTurn(model, thread, command.turnId);
      if ("code" in found) return fail(found.code, found.message);
      const { turn } = found;
      if (command.restoreFiles) {
        if (thread.worktreePath === undefined) return fail("conflict", `thread ${thread.id} ${NEEDS_WORKTREE}`);
        if (turn.checkpoint?.before === undefined) return fail("conflict", `turn ${turn.id} has no before-checkpoint`);
      }
      return ok({
        type: "rollback.requested",
        threadId: thread.id,
        turnId: turn.id,
        restoreFiles: command.restoreFiles,
        turnIds: rolledBackTurnIds(model, turn),
        at: ctx.now,
      });
    }

    case "rollback.report": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      const rollback = thread.rollback;
      if (rollback?.status !== "rolling") return fail("conflict", `thread ${thread.id} is not rolling back`);
      if (command.outcome === "error") {
        return ok({ type: "rollback.failed", threadId: thread.id, turnId: rollback.turnId, error: command.error ?? "rollback failed", at: ctx.now });
      }
      const turn = model.turns[rollback.turnId];
      return ok({
        type: "rollback.completed",
        threadId: thread.id,
        turnId: rollback.turnId,
        turnIds: turn === undefined ? [] : rolledBackTurnIds(model, turn),
        at: ctx.now,
      });
    }
  }
}
