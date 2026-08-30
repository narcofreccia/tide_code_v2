import { Type, type Static } from "typebox";
import { Project, Thread, Turn, Message } from "./domain.ts";

// Events = persisted facts. Payloads are self-contained so the projector
// never needs to look anything up outside the event.

const evt = <T extends string, P extends Parameters<typeof Type.Object>[0]>(type: T, props: P) =>
  Type.Object({ type: Type.Literal(type), ...props });

export const ProjectCreated = evt("project.created", { project: Project });
export const ProjectUpdated = evt("project.updated", {
  projectId: Type.String(),
  title: Type.Optional(Type.String()),
  updatedAt: Type.Number(),
});
export const ProjectArchived = evt("project.archived", { projectId: Type.String(), archivedAt: Type.Number() });

export const ThreadCreated = evt("thread.created", { thread: Thread });
export const ThreadUpdated = evt("thread.updated", {
  threadId: Type.String(),
  patch: Type.Partial(Type.Pick(Thread, ["title", "provider", "model", "mode", "interaction", "worktreePath", "branch"])),
  updatedAt: Type.Number(),
});
export const ThreadArchived = evt("thread.archived", { threadId: Type.String(), archivedAt: Type.Number() });
export const ThreadStatusChanged = evt("thread.status-changed", {
  threadId: Type.String(),
  status: Thread.properties.status,
  updatedAt: Type.Number(),
});

export const TurnRequested = evt("turn.requested", { turn: Turn, userMessage: Message });
export const TurnStarted = evt("turn.started", { turnId: Type.String(), threadId: Type.String(), startedAt: Type.Number() });
export const AssistantDelta = evt("assistant.delta", {
  turnId: Type.String(),
  threadId: Type.String(),
  messageId: Type.String(),
  delta: Type.String(),
  at: Type.Number(),
});
export const TurnSettled = evt("turn.settled", {
  turnId: Type.String(),
  threadId: Type.String(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("interrupted"), Type.Literal("error")]),
  error: Type.Optional(Type.String()),
  settledAt: Type.Number(),
});

export const DomainEvent = Type.Union([
  ProjectCreated,
  ProjectUpdated,
  ProjectArchived,
  ThreadCreated,
  ThreadUpdated,
  ThreadArchived,
  ThreadStatusChanged,
  TurnRequested,
  TurnStarted,
  AssistantDelta,
  TurnSettled,
]);
export type DomainEvent = Static<typeof DomainEvent>;
export type EventOf<T extends DomainEvent["type"]> = Extract<DomainEvent, { type: T }>;

/** Persisted/streamed envelope: the log assigns seq; ts is server time. */
export const EventRecord = Type.Object({
  seq: Type.Number(),
  ts: Type.Number(),
  event: DomainEvent,
});
export type EventRecord = Static<typeof EventRecord>;
