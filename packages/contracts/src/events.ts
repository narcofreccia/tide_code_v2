import { Type, type Static } from "typebox";
import { Activity, ApprovalDecision, Message, Project, ProposedPlan, ProviderKind, Thread, Turn, TurnUsage } from "./domain.ts";

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
  patch: Type.Partial(Type.Pick(Thread, ["title", "provider", "model", "mode", "interaction", "worktreePath", "branch", "nativeSessionId"])),
  updatedAt: Type.Number(),
});
export const ThreadArchived = evt("thread.archived", { threadId: Type.String(), archivedAt: Type.Number() });
export const ThreadStatusChanged = evt("thread.status-changed", {
  threadId: Type.String(),
  status: Thread.properties.status,
  updatedAt: Type.Number(),
});

export const TurnRequested = evt("turn.requested", { turn: Turn, userMessage: Message });
export const TurnStarted = evt("turn.started", {
  turnId: Type.String(),
  threadId: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  nativeSessionId: Type.Optional(Type.String()),
  startedAt: Type.Number(),
});
export const TurnInterruptRequested = evt("turn.interrupt-requested", { turnId: Type.String(), threadId: Type.String(), at: Type.Number() });
export const ActivityUpserted = evt("activity.upserted", { activity: Activity });
export const ApprovalResponded = evt("approval.responded", {
  threadId: Type.String(),
  requestId: Type.String(),
  decision: ApprovalDecision,
  at: Type.Number(),
});
export const UserInputResponded = evt("user-input.responded", {
  threadId: Type.String(),
  requestId: Type.String(),
  answers: Type.Record(Type.String(), Type.Unknown()),
  at: Type.Number(),
});
export const PlanProposed = evt("plan.proposed", { plan: ProposedPlan });
export const PlanUpdated = evt("plan.updated", {
  planId: Type.String(),
  status: ProposedPlan.properties.status,
  implementationThreadId: Type.Optional(Type.String()),
  at: Type.Number(),
});
export const PlanProgressed = evt("plan.progressed", {
  threadId: Type.String(),
  steps: Thread.properties.planProgress.properties.steps,
  at: Type.Number(),
});
export const UsageReported = evt("usage.reported", {
  turnId: Type.String(),
  threadId: Type.String(),
  usage: Type.Optional(TurnUsage),
  contextUsage: Type.Optional(Type.Object({ used: Type.Number(), window: Type.Number() })),
  at: Type.Number(),
});
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
  TurnInterruptRequested,
  AssistantDelta,
  ActivityUpserted,
  ApprovalResponded,
  UserInputResponded,
  PlanProposed,
  PlanUpdated,
  PlanProgressed,
  UsageReported,
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
