import { applyEvent, quotaBlock, rootThread, type Command, type DomainEvent, type EventOf, type QuotaBlock, type QuotaScope, type ReadModel, type Thread, type Turn } from "@tide/contracts";
import { descendantsOf } from "./descendants.ts";
import { fail, ok, type DecideContext, type DecideResult } from "./types.ts";

// R20 enforcement: the one place a usage quota stops new work. Every command that opens a turn
// goes through `gateTurns`, so delegate, team, experts, tasks, resume and plan-implement need no
// check of their own.

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What a person reads when a turn is refused: whose quota, until when, and what to do. */
export function quotaMessage(model: ReadModel, block: QuotaBlock): string {
  const owner = block.scope === "project" ? model.projects[block.id]?.title : model.threads[block.id]?.title;
  const scope = `${block.scope} "${owner ?? block.id}"`;
  const resets = block.state.windowEndsAt !== undefined ? `; it resets at ${utc(block.state.windowEndsAt)}` : "";
  return `the usage quota of ${scope} is used up${resets}. Lift it until the reset or edit the quota to continue`;
}

const isHarnessTurn = (e: EventOf<"turn.requested">): boolean => e.userMessage.notification?.source === "harness";

/**
 * Post-check of a decided command. A `turn.requested` that would start on a quota-blocked thread
 * is refused, except: a harness's own turn (it is already spending, Tide only records it) passes,
 * and a server wake-up (`turn.request` carrying a notification) is kept but queued, so it runs
 * once the quota frees the thread.
 */
export function gateTurns(model: ReadModel, command: Command, result: DecideResult, ctx: DecideContext): DecideResult {
  if (!result.ok) return result;
  if (!result.events.some((e) => e.type === "turn.requested" && e.turn.status === "requested")) return result;
  let scratch = model;
  const events: DomainEvent[] = [];
  let changed = false;
  for (const event of result.events) {
    if (event.type === "turn.requested" && event.turn.status === "requested" && !isHarnessTurn(event)) {
      // the thread may have been created (or a project with it) earlier in this same batch
      const thread = scratch.threads[event.turn.threadId];
      const block = thread !== undefined ? quotaBlock(scratch, thread, ctx.now) : undefined;
      if (block !== undefined) {
        if (command.type !== "turn.request" || command.notification === undefined) return fail("quota-exceeded", quotaMessage(scratch, block));
        const queued: EventOf<"turn.requested"> = { ...event, turn: { ...event.turn, status: "queued" } };
        events.push(queued);
        scratch = applyEvent(scratch, queued);
        changed = true;
        continue;
      }
    }
    events.push(event);
    scratch = applyEvent(scratch, event);
  }
  return changed ? ok(...events) : result;
}

function queuedTurns(model: ReadModel, threadId: string): Turn[] {
  return Object.values(model.turns)
    .filter((t) => t.threadId === threadId && t.status === "queued")
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

export const oldestQueued = (model: ReadModel, threadId: string): Turn | undefined => queuedTurns(model, threadId)[0];

/**
 * Whether the settle of a turn on `thread` keeps the queue behind it: the harness said it hit its
 * limit, or a quota holds the thread now. Only meaningful with something queued. A queued
 * harness turn is not held by a quota (it is already spending).
 */
export function holdsQueue(model: ReadModel, thread: Thread, settlingTurnId: string, harnessLimit: boolean, now: number): boolean {
  const next = queuedTurns(model, thread.id).filter((t) => t.id !== settlingTurnId)[0];
  if (next === undefined) return false;
  if (harnessLimit) return true;
  const prompt = (model.threadMessages[thread.id] ?? []).map((id) => model.messages[id]).find((m) => m?.turnId === next.id && m.role === "user");
  if (prompt?.notification?.source === "harness") return false;
  return quotaBlock(model, thread, now) !== undefined;
}

/** A `turn.released` for `thread`'s oldest queued turn when it is idle, unarchived, not limited and no quota holds it. */
export function releaseFor(model: ReadModel, thread: Thread, ctx: Pick<DecideContext, "now">): EventOf<"turn.released"> | undefined {
  if (thread.status === "running" || thread.archivedAt !== undefined || thread.limited !== undefined) return undefined;
  const turn = oldestQueued(model, thread.id);
  if (turn === undefined || quotaBlock(model, thread, ctx.now) !== undefined) return undefined;
  return { type: "turn.released", threadId: thread.id, turnId: turn.id, at: ctx.now };
}

function threadsInScope(model: ReadModel, scope: QuotaScope, id: string): Thread[] {
  if (scope === "thread") {
    const thread = model.threads[id];
    return thread === undefined ? [] : [thread, ...descendantsOf(model, id)];
  }
  // a delegate living in another project counts where its lineage started
  return Object.values(model.threads).filter((t) => rootThread(model, t).projectId === id);
}

/**
 * After a quota event (set, removed, lifted, metered): one release per idle thread in the scope
 * that the new state no longer holds. Evaluated on the model with the quota events applied.
 */
export function withReleases(model: ReadModel, scope: QuotaScope, id: string, result: DecideResult, ctx: Pick<DecideContext, "now">): DecideResult {
  if (!result.ok || result.events.length === 0) return result;
  const after = result.events.reduce(applyEvent, model);
  const releases: DomainEvent[] = [];
  for (const thread of threadsInScope(after, scope, id)) {
    const release = releaseFor(after, thread, ctx);
    if (release !== undefined) releases.push(release);
  }
  return releases.length === 0 ? result : ok(...result.events, ...releases);
}
