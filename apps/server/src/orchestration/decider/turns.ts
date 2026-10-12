import type { CommandOf, Message, ReadModel, Turn, TurnStatus } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type TurnCommand =
  | CommandOf<"turn.request">
  | CommandOf<"turn.dequeue">
  | CommandOf<"turn.interrupt">
  | CommandOf<"turn.start">
  | CommandOf<"assistant.append">
  | CommandOf<"assistant.reasoning.append">
  | CommandOf<"usage.report">
  | CommandOf<"turn.settle">;

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);
const INTERRUPTIBLE: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["requested", "running"]);

export function decideTurn(model: ReadModel, command: TurnCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "turn.request": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.worktreePath === undefined && thread.branch !== undefined) {
        // the worktree was detached: running now would silently edit the user's main checkout
        return fail("conflict", `thread ${thread.id} has no worktree any more; archive it or start a new thread`);
      }
      if (command.requestId !== undefined) {
        const dup = Object.values(model.turns).find((t) => t.threadId === thread.id && t.requestId === command.requestId);
        if (dup) return fail("conflict", `turn ${dup.id} already carries requestId ${command.requestId}`);
      }
      // a follow-up typed while the harness is busy waits its turn instead of being refused
      const queued = thread.status === "running";
      const turn: Turn = {
        id: ctx.newId(),
        threadId: thread.id,
        status: queued ? "queued" : "requested",
        ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
        requestedAt: ctx.now,
      };
      const images = command.images ?? [];
      const userMessage: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: turn.id,
        role: "user",
        text: command.text,
        ...(images.length > 0 ? { attachments: images.map((img) => ({ mediaType: img.mediaType, bytes: Math.floor((img.data.length * 3) / 4) })) } : {}),
        createdAt: ctx.now,
      };
      return ok({ type: "turn.requested", turn, userMessage, ...(images.length > 0 ? { images } : {}) });
    }

    case "turn.dequeue": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (turn.status !== "queued") return fail("conflict", `turn ${turn.id} is ${turn.status}, only queued turns can be dequeued`);
      return ok({ type: "turn.dequeued", turnId: turn.id, threadId: turn.threadId, at: ctx.now });
    }

    case "turn.interrupt": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (thread.status !== "running") return fail("conflict", `thread ${thread.id} is not running`);
      const turn = thread.latestTurnId === undefined ? undefined : model.turns[thread.latestTurnId];
      if (!turn) return fail("conflict", `thread ${thread.id} has no live turn`);
      if (!INTERRUPTIBLE.has(turn.status)) return fail("conflict", `turn ${turn.id} is ${turn.status}`);
      return ok({ type: "turn.interrupt-requested", turnId: turn.id, threadId: thread.id, at: ctx.now });
    }

    case "turn.start": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      const thread = model.threads[turn.threadId];
      if (!thread) return fail("not-found", `unknown thread ${turn.threadId}`);
      if (thread.latestTurnId !== turn.id) return fail("conflict", `turn ${turn.id} is not the latest turn of ${thread.id}`);
      if (turn.status !== "requested") return fail("conflict", `turn ${turn.id} is already ${turn.status}`);
      return ok({
        type: "turn.started",
        turnId: turn.id,
        threadId: thread.id,
        provider: command.provider,
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.nativeSessionId !== undefined ? { nativeSessionId: command.nativeSessionId } : {}),
        startedAt: ctx.now,
      });
    }

    case "assistant.append": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (SETTLED.has(turn.status)) return fail("conflict", `turn ${turn.id} is already settled`);
      return ok({
        type: "assistant.delta",
        turnId: turn.id,
        threadId: turn.threadId,
        messageId: command.messageId,
        delta: command.delta,
        at: ctx.now,
      });
    }

    case "assistant.reasoning.append": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (SETTLED.has(turn.status)) return fail("conflict", `turn ${turn.id} is already settled`);
      return ok({
        type: "assistant.reasoning-delta",
        turnId: turn.id,
        threadId: turn.threadId,
        messageId: command.messageId,
        delta: command.delta,
        at: ctx.now,
      });
    }

    case "usage.report": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      return ok({
        type: "usage.reported",
        turnId: turn.id,
        threadId: turn.threadId,
        ...(command.usage !== undefined ? { usage: command.usage } : {}),
        ...(command.contextUsage !== undefined ? { contextUsage: command.contextUsage } : {}),
        ...(command.rateLimit !== undefined ? { rateLimit: command.rateLimit } : {}),
        at: ctx.now,
      });
    }

    case "turn.settle": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (SETTLED.has(turn.status)) return fail("conflict", `turn ${turn.id} is already settled`);
      return ok({
        type: "turn.settled",
        turnId: turn.id,
        threadId: turn.threadId,
        status: command.status,
        ...(command.error !== undefined ? { error: command.error } : {}),
        settledAt: ctx.now,
      });
    }
  }
}
