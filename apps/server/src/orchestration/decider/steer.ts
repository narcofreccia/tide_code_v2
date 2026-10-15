import type { CommandOf, Message, ReadModel, Thread, Turn, TurnStatus } from "@tide/contracts";
import { attachmentsOf, fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type SteerCommand =
  | CommandOf<"turn.steer">
  | CommandOf<"steer.fallback">
  | CommandOf<"turn.edit">
  | CommandOf<"turn.reorder">
  | CommandOf<"turn.promote">
  | CommandOf<"handoff.delivered">;

const LIVE: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["requested", "running"]);
const NOTHING_RUNNING = "nothing is running; use turn.request";

/** The thread's turn a steer can land in, when there is one. */
function liveTurn(model: ReadModel, thread: Thread): Turn | undefined {
  if (thread.status !== "running" || thread.latestTurnId === undefined) return undefined;
  const turn = model.turns[thread.latestTurnId];
  return turn !== undefined && LIVE.has(turn.status) ? turn : undefined;
}

/** The user message that opened `turn` (its prompt). */
function promptOf(model: ReadModel, turn: Turn): Message | undefined {
  const ids = model.threadMessages[turn.threadId] ?? [];
  for (const id of ids) {
    const m = model.messages[id];
    if (m !== undefined && m.turnId === turn.id && m.role === "user" && m.steer !== true) return m;
  }
  return undefined;
}

/**
 * Talking to a running turn and editing the queue behind it. A steer is recorded as a user
 * message inside the live turn; the provider reactor delivers it, or answers `steer.fallback`
 * when the harness cannot take it, and the message becomes a turn of its own.
 */
export function decideSteer(model: ReadModel, command: SteerCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "turn.steer": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      const turn = liveTurn(model, thread);
      if (!turn) return fail("conflict", NOTHING_RUNNING);
      const message: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: turn.id,
        role: "user",
        text: command.text,
        ...attachmentsOf(command.images),
        steer: true,
        createdAt: ctx.now,
      };
      const images = command.images ?? [];
      return ok({ type: "turn.steered", turnId: turn.id, threadId: thread.id, message, ...(images.length > 0 ? { images } : {}) });
    }

    case "steer.fallback": {
      const message = model.messages[command.messageId];
      if (!message) return fail("not-found", `unknown message ${command.messageId}`);
      if (message.role !== "user" || message.steer !== true) return fail("conflict", `message ${message.id} is not a steer`);
      const thread = model.threads[message.threadId];
      if (!thread) return fail("not-found", `unknown thread ${message.threadId}`);
      // still running: wait behind the live turn; otherwise the fallback takes the thread now
      const queued = thread.status === "running";
      const turn: Turn = {
        id: ctx.newId(),
        threadId: thread.id,
        status: queued ? "queued" : "requested",
        ...(thread.pendingHandoffId !== undefined ? { handoffId: thread.pendingHandoffId } : {}),
        requestedAt: ctx.now,
      };
      const userMessage: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: turn.id,
        role: "user",
        text: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        createdAt: ctx.now,
      };
      return ok({ type: "turn.steer-fell-back", threadId: thread.id, messageId: message.id, reason: command.reason, turn, userMessage, at: ctx.now });
    }

    case "turn.edit": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (turn.status !== "queued") return fail("conflict", `turn ${turn.id} is ${turn.status}, only queued turns can be edited`);
      const prompt = promptOf(model, turn);
      if (!prompt) return fail("not-found", `turn ${turn.id} has no user message`);
      return ok({ type: "turn.edited", turnId: turn.id, threadId: turn.threadId, messageId: prompt.id, text: command.text, at: ctx.now });
    }

    case "turn.reorder": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      const queued = new Set(Object.values(model.turns).filter((t) => t.threadId === thread.id && t.status === "queued").map((t) => t.id));
      const given = new Set(command.turnIds);
      const exact = given.size === command.turnIds.length && given.size === queued.size && command.turnIds.every((id) => queued.has(id));
      if (!exact) return fail("invalid-command", `turn.reorder must list every queued turn of ${thread.id} exactly once`);
      return ok({ type: "turns.reordered", threadId: thread.id, turnIds: command.turnIds, at: ctx.now });
    }

    case "turn.promote": {
      const queuedTurn = model.turns[command.turnId];
      if (!queuedTurn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (queuedTurn.status !== "queued") return fail("conflict", `turn ${queuedTurn.id} is ${queuedTurn.status}, only queued turns can be promoted`);
      const thread = model.threads[queuedTurn.threadId];
      if (!thread) return fail("not-found", `unknown thread ${queuedTurn.threadId}`);
      const live = liveTurn(model, thread);
      if (!live) return fail("conflict", "nothing is running; the turn will start on its own");
      // dequeuing would drop the handoff the queued turn was carrying to the harness
      if (queuedTurn.handoffId !== undefined) return fail("conflict", `turn ${queuedTurn.id} carries a handoff; it cannot be promoted`);
      const prompt = promptOf(model, queuedTurn);
      if (!prompt) return fail("not-found", `turn ${queuedTurn.id} has no user message`);
      // the image bytes are not in the model, so a steer would arrive without them
      if (prompt.attachments !== undefined && prompt.attachments.length > 0) {
        return fail("conflict", `turn ${queuedTurn.id} carries images; it cannot be promoted into the running turn`);
      }
      const message: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: live.id,
        role: "user",
        text: prompt.text,
        steer: true,
        createdAt: ctx.now,
      };
      return ok(
        { type: "turn.dequeued", turnId: queuedTurn.id, threadId: thread.id, at: ctx.now },
        { type: "turn.steered", turnId: live.id, threadId: thread.id, message },
      );
    }

    case "handoff.delivered": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (turn.handoffId === undefined) return fail("conflict", `turn ${turn.id} carries no handoff`);
      return ok({ type: "handoff.delivered", turnId: turn.id, threadId: turn.threadId, handoffId: turn.handoffId, delivery: command.delivery, at: ctx.now });
    }
  }
}
