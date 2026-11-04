import type { CommandOf, DomainEvent, ReadModel, Thread, Turn, TurnStatus } from "@tide/contracts";
import { handoffTurns } from "../handoff/select.ts";
import { recordHandoff } from "./handoff.ts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);
const TITLE_PREFIX_MAX = 40;
export const SIDE_TITLE_FALLBACK = "Side chat";

/** `Side: <first 40 chars of the parent's title>`, or "Side chat" for an untitled parent. */
export function sideTitle(parentTitle: string): string {
  const head = parentTitle.trim().slice(0, TITLE_PREFIX_MAX).trimEnd();
  return head === "" ? SIDE_TITLE_FALLBACK : `Side: ${head}`;
}

/** The parent's newest settled, surviving turn: where a side chat picks up the conversation. */
function latestSettledTurn(model: ReadModel, threadId: string): Turn | undefined {
  const turns = handoffTurns(model, threadId);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn !== undefined && SETTLED.has(turn.status)) return turn;
  }
  return undefined;
}

/**
 * `thread.side`: a sibling conversation on the parent's harness and checkout. With history it is a
 * fork at the parent's latest settled turn (full handoff, `forkedFrom`); without, a bare thread.
 * The checkout is shared, never created: no `useWorktree`/`baseRef`, and the parent's worktree is
 * attached the way `thread.delegate { inheritWorktreeFrom }` does it, so the parent stays owner.
 */
export function decideSide(model: ReadModel, command: CommandOf<"thread.side">, ctx: DecideContext): DecideResult {
  const parent = model.threads[command.threadId];
  if (!parent) return fail("not-found", `unknown thread ${command.threadId}`);
  if (isArchived(parent)) return fail("conflict", `thread ${parent.id} is archived`);
  if (parent.role === "side") return fail("conflict", `thread ${parent.id} is a side chat; side chats do not nest`);
  if (parent.rollback?.status === "rolling") return fail("busy", `thread ${parent.id} is rolling back`);

  const turn = latestSettledTurn(model, parent.id);
  const turns = turn === undefined ? [] : handoffTurns(model, parent.id, { untilTurnId: turn.id });
  const forked = turn !== undefined && turns.length > 0;
  const thread: Thread = {
    id: ctx.newId(),
    projectId: parent.projectId,
    parentThreadId: parent.id,
    ...(forked ? { forkedFrom: { threadId: parent.id, turnId: turn.id } } : {}),
    title: command.title ?? sideTitle(parent.title),
    provider: parent.provider,
    ...(parent.providerId !== undefined ? { providerId: parent.providerId } : {}),
    ...(parent.model !== undefined ? { model: parent.model } : {}),
    ...(parent.effort !== undefined ? { effort: parent.effort } : {}),
    mode: parent.mode,
    interaction: parent.interaction,
    role: "side",
    ...(parent.links !== undefined ? { links: parent.links } : {}),
    status: "idle",
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  const events: DomainEvent[] = [{ type: "thread.created", thread }];
  if (parent.worktreePath !== undefined && parent.branch !== undefined) {
    events.push({
      type: "worktree.attached",
      threadId: thread.id,
      worktreePath: parent.worktreePath,
      branch: parent.branch,
      ...(parent.baseBranch !== undefined ? { baseBranch: parent.baseBranch } : {}),
      at: ctx.now,
    });
  }
  if (forked) {
    events.push(recordHandoff(model, { threadId: thread.id, source: parent, fromProvider: parent.provider, toProvider: parent.provider, strategy: "full", turns }, ctx));
  }
  return ok(...events);
}
