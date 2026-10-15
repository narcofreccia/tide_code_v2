import { emptyReadModel, replay, type Command, type DomainEvent, type ProviderKind, type ReadModel } from "@tide/contracts";
import { decide } from "./index.ts";
import type { DecideContext, DecideResult } from "./types.ts";

/** Shared fixtures for the R4 decider tests: a clock that advances per command so turn order is real. */
let counter = 0;
export const ctx: DecideContext = { now: 1000, newId: () => `r4-${++counter}` };

export function tryRun(model: ReadModel, command: Command): DecideResult {
  ctx.now += 10;
  return decide(model, command, ctx);
}

export function apply(model: ReadModel, events: DomainEvent[]): ReadModel {
  return replay(model, events.map((event, i) => ({ seq: model.seq + i + 1, ts: ctx.now, event })));
}

export function run(model: ReadModel, command: Command): { model: ReadModel; events: DomainEvent[] } {
  const result = tryRun(model, command);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.code} ${result.error.message}`);
  return { model: apply(model, result.events), events: result.events };
}

export function eventOf<T extends DomainEvent["type"]>(events: DomainEvent[], type: T): Extract<DomainEvent, { type: T }> {
  const found = events.find((e) => e.type === type);
  if (!found) throw new Error(`expected ${type} in ${events.map((e) => e.type).join(", ")}`);
  return found as Extract<DomainEvent, { type: T }>;
}

export interface Fixture {
  model: ReadModel;
  threadId: string;
}

export function withThread(provider: ProviderKind = "claude", worktree = false): Fixture {
  const project = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: `/repo-${++counter}` });
  const projectId = eventOf(project.events, "project.created").project.id;
  const t = run(project.model, { type: "thread.create", projectId, provider, title: "Login fix", ...(worktree ? { useWorktree: true } : {}) });
  const threadId = eventOf(t.events, "thread.created").thread.id;
  if (!worktree) return { model: t.model, threadId };
  const model = run(t.model, { type: "worktree.attach", threadId, worktreePath: "/wt/thread", branch: "tide/login", baseBranch: "main" }).model;
  return { model, threadId };
}

/** Requests and starts a turn, leaving it running. */
export function startTurn(model: ReadModel, threadId: string, text: string, nativeSessionId?: string): { model: ReadModel; turnId: string } {
  const req = run(model, { type: "turn.request", threadId, text });
  const turnId = eventOf(req.events, "turn.requested").turn.id;
  const provider = req.model.threads[threadId]?.provider ?? "claude";
  const next = run(req.model, { type: "turn.start", turnId, provider, ...(nativeSessionId !== undefined ? { nativeSessionId } : {}) }).model;
  return { model: next, turnId };
}

/** A whole turn: prompt, reply, checkpoints, settle. */
export function completeTurn(model: ReadModel, threadId: string, text: string, reply: string, nativeSessionId?: string): { model: ReadModel; turnId: string } {
  const started = startTurn(model, threadId, text, nativeSessionId);
  const { turnId } = started;
  let next = run(started.model, { type: "checkpoint.record", turnId, phase: "before", ref: `before-${turnId}` }).model;
  next = run(next, { type: "assistant.append", turnId, messageId: `msg-${turnId}`, delta: reply }).model;
  next = run(next, { type: "checkpoint.record", turnId, phase: "after", ref: `after-${turnId}` }).model;
  next = run(next, { type: "turn.settle", turnId, status: "completed" }).model;
  return { model: next, turnId };
}
