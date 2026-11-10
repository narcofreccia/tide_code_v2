import type { CommandOf, DomainEvent, EventOf, Message, ReadModel, Thread, Turn, TurnStatus } from "@tide/contracts";
import { autoTitleEvent } from "./autoTitle.ts";
import { attachmentsOf, badAttachment, fail, instanceKey, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type TurnCommand =
  | CommandOf<"turn.request">
  | CommandOf<"turn.dequeue">
  | CommandOf<"turn.interrupt">
  | CommandOf<"turn.start">
  | CommandOf<"turn.session">
  | CommandOf<"assistant.append">
  | CommandOf<"assistant.reasoning.append">
  | CommandOf<"usage.report">
  | CommandOf<"turn.settle">;

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);

/**
 * R17: a turn that starts the thread on a brand-new native session (`/clear` that keeps Tide's
 * history): the requested turn marked `freshSession`, then the `session.boundary` that releases the
 * instance's native session. Refused while a turn runs: a queued fresh turn would close the live
 * session under it. Returns the reason when refused.
 */
export function freshSessionEvents(
  thread: Thread,
  requested: EventOf<"turn.requested">,
  ctx: Pick<DecideContext, "now">,
): { events: [EventOf<"turn.requested">, EventOf<"session.boundary">] } | { refused: string } {
  if (thread.status === "running") return { refused: "wait for the running turn to settle before starting a fresh session" };
  const turn: Turn = { ...requested.turn, freshSession: true };
  return {
    events: [
      { ...requested, turn },
      { type: "session.boundary", threadId: thread.id, turnId: turn.id, providerId: instanceKey(thread), at: ctx.now },
    ],
  };
}

const INTERRUPTIBLE: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["requested", "running"]);

export function decideTurn(model: ReadModel, command: TurnCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "turn.request": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.rollback?.status === "rolling") return fail("busy", `thread ${thread.id} is rolling back`);
      if (thread.worktreePath === undefined && thread.branch !== undefined) {
        // the worktree was detached: running now would silently edit the user's main checkout
        return fail("conflict", `thread ${thread.id} has no worktree any more; archive it or start a new thread`);
      }
      if (command.requestId !== undefined) {
        const dup = Object.values(model.turns).find((t) => t.threadId === thread.id && t.requestId === command.requestId);
        if (dup) return fail("conflict", `turn ${dup.id} already carries requestId ${command.requestId}`);
      }
      const badFile = badAttachment(command.attachments);
      if (badFile !== undefined) return fail("invalid-command", badFile);
      // a follow-up typed while the harness is busy waits its turn instead of being refused
      const queued = thread.status === "running";
      const turn: Turn = {
        id: ctx.newId(),
        threadId: thread.id,
        status: queued ? "queued" : "requested",
        ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
        // a provider switch / fork left context for the harness: this turn carries it
        ...(thread.pendingHandoffId !== undefined ? { handoffId: thread.pendingHandoffId } : {}),
        requestedAt: ctx.now,
      };
      const images = command.images ?? [];
      const userMessage: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: turn.id,
        role: "user",
        text: command.text,
        ...attachmentsOf(images, command.attachments),
        ...(command.notification !== undefined ? { notification: command.notification } : {}),
        createdAt: ctx.now,
      };
      const requested: EventOf<"turn.requested"> = { type: "turn.requested", turn, userMessage, ...(images.length > 0 ? { images } : {}) };
      let events: DomainEvent[] = [requested];
      if (command.freshSession === true) {
        const fresh = freshSessionEvents(thread, requested, ctx);
        if ("refused" in fresh) return fail("conflict", fresh.refused);
        events = fresh.events;
      }
      // the first prompt a user types names an untitled thread; a queued follow-up or a
      // server-sent notification turn never does
      const titled = queued || command.notification !== undefined ? undefined : autoTitleEvent(thread, command.text, ctx.now);
      return titled !== undefined ? ok(titled, ...events) : ok(...events);
    }

    /** R17: the native id arrived after turn.started; idempotent when already known */
    case "turn.session": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      const thread = model.threads[turn.threadId];
      if (!thread) return fail("not-found", `unknown thread ${turn.threadId}`);
      if (turn.status !== "running") return fail("conflict", `turn ${turn.id} is ${turn.status}, not running`);
      const key = turn.providerId ?? thread.providerId ?? turn.provider ?? thread.provider;
      if (thread.providerSessions?.[key]?.nativeSessionId === command.nativeSessionId && thread.nativeSessionId === command.nativeSessionId) return ok();
      return ok({
        type: "turn.session-identified",
        turnId: turn.id,
        threadId: thread.id,
        provider: turn.provider ?? thread.provider,
        ...((turn.providerId ?? thread.providerId) !== undefined ? { providerId: turn.providerId ?? thread.providerId } : {}),
        ...(command.model !== undefined ? { model: command.model } : {}),
        nativeSessionId: command.nativeSessionId,
        at: ctx.now,
      });
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
      // R18 D1: the driver had to start a new native session although a resume was asked for —
      // the turn records the boundary first (the new id below then lands on a cleared thread).
      const lostResume = command.freshSession === true && turn.freshSession !== true;
      const boundary: DomainEvent[] = lostResume ? [{ type: "session.boundary", threadId: thread.id, turnId: turn.id, providerId: command.providerId ?? instanceKey(thread), at: ctx.now }] : [];
      return ok(...boundary, {
        type: "turn.started",
        turnId: turn.id,
        threadId: thread.id,
        provider: command.provider,
        // the instance that runs it, so a later switch back resumes the right account's session
        ...(command.providerId !== undefined ? { providerId: command.providerId } : thread.providerId !== undefined ? { providerId: thread.providerId } : {}),
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
