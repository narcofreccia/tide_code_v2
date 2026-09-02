import { Type, type Static } from "typebox";
import { Activity, ApprovalDecision, CheckpointStats, ExpertsFinding, ExpertsMessage, ExpertsPhase, ExpertsSession, ImageInput, Message, Project, ProjectLink, ProposedPlan, ProviderKind, PullRequest, Thread, Turn, TurnUsage } from "./domain.ts";

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
export const ProjectLinkAdded = evt("project.link.added", { projectId: Type.String(), link: ProjectLink, updatedAt: Type.Number() });
export const ProjectLinkUpdated = evt("project.link.updated", { projectId: Type.String(), link: ProjectLink, updatedAt: Type.Number() });
export const ProjectLinkRemoved = evt("project.link.removed", { projectId: Type.String(), linkId: Type.String(), updatedAt: Type.Number() });

/** `useWorktree` is an intent for the vcs reactor, not state; the reactor answers with worktree.attached. */
export const ThreadCreated = evt("thread.created", { thread: Thread, useWorktree: Type.Optional(Type.Boolean()) });
export const ThreadUpdated = evt("thread.updated", {
  threadId: Type.String(),
  patch: Type.Partial(Type.Pick(Thread, ["title", "provider", "model", "mode", "interaction", "worktreePath", "branch", "baseBranch", "nativeSessionId"])),
  updatedAt: Type.Number(),
});
export const ThreadArchived = evt("thread.archived", { threadId: Type.String(), archivedAt: Type.Number(), keepWorktree: Type.Optional(Type.Boolean()) });
export const ThreadStatusChanged = evt("thread.status-changed", {
  threadId: Type.String(),
  status: Thread.properties.status,
  updatedAt: Type.Number(),
});

/** `turn.status` is `queued` when another turn of the thread is still running. Image bytes live
 *  only here (the projector keeps metadata on the message); the provider reactor reads them. */
export const TurnRequested = evt("turn.requested", { turn: Turn, userMessage: Message, images: Type.Optional(Type.Array(ImageInput)) });
export const TurnDequeued = evt("turn.dequeued", { turnId: Type.String(), threadId: Type.String(), at: Type.Number() });
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
export const WorktreeAttached = evt("worktree.attached", {
  threadId: Type.String(),
  worktreePath: Type.String(),
  branch: Type.String(),
  baseBranch: Type.Optional(Type.String()),
  at: Type.Number(),
});
export const CheckpointRecorded = evt("checkpoint.recorded", {
  turnId: Type.String(),
  threadId: Type.String(),
  phase: Type.Union([Type.Literal("before"), Type.Literal("after")]),
  ref: Type.String(),
  stats: Type.Optional(CheckpointStats),
  at: Type.Number(),
});
export const WorktreeDetachRequested = evt("worktree.detach-requested", { threadId: Type.String(), deleteBranch: Type.Optional(Type.Boolean()), at: Type.Number() });
export const WorktreeDetached = evt("worktree.detached", { threadId: Type.String(), at: Type.Number() });
export const RevertRequested = evt("revert.requested", { threadId: Type.String(), turnId: Type.String(), at: Type.Number() });
export const PublishRequested = evt("publish.requested", {
  threadId: Type.String(),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  commitOnly: Type.Optional(Type.Boolean()),
  at: Type.Number(),
});
export const PrUpdated = evt("pr.updated", { threadId: Type.String(), pr: PullRequest });
export const ExpertsCreated = evt("experts.created", { session: ExpertsSession });
export const ExpertsThreadsBoundEvt = evt("experts.threads-bound", {
  sessionId: Type.String(),
  bindings: Type.Array(Type.Object({ key: Type.String(), threadId: Type.String() })),
  leadThreadId: Type.String(),
  at: Type.Number(),
});
export const ExpertsPhaseChanged = evt("experts.phase-changed", { sessionId: Type.String(), phase: ExpertsPhase, at: Type.Number() });
export const ExpertsExpertStatusChanged = evt("experts.expert-status-changed", {
  sessionId: Type.String(),
  key: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("working"), Type.Literal("idle"), Type.Literal("error")]),
  at: Type.Number(),
});
export const ExpertsFindingPosted = evt("experts.finding-posted", { finding: ExpertsFinding });
export const ExpertsMessagePosted = evt("experts.message-posted", { message: ExpertsMessage });
export const ExpertsSynthesisSetEvt = evt("experts.synthesis-set", { sessionId: Type.String(), markdown: Type.String(), planId: Type.Optional(Type.String()), at: Type.Number() });
export const ExpertsArchived = evt("experts.archived", { sessionId: Type.String(), at: Type.Number() });
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
export const AssistantReasoningDelta = evt("assistant.reasoning-delta", {
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
  ProjectArchived, ProjectLinkAdded, ProjectLinkUpdated, ProjectLinkRemoved,
  ThreadCreated,
  ThreadUpdated,
  ThreadArchived,
  ThreadStatusChanged,
  TurnRequested,
  TurnDequeued,
  TurnStarted,
  TurnInterruptRequested,
  AssistantDelta,
  AssistantReasoningDelta,
  ActivityUpserted,
  ApprovalResponded,
  UserInputResponded,
  PlanProposed,
  PlanUpdated,
  PlanProgressed,
  UsageReported,
  WorktreeAttached,
  WorktreeDetachRequested,
  WorktreeDetached,
  CheckpointRecorded,
  RevertRequested,
  PublishRequested,
  PrUpdated,
  ExpertsCreated,
  ExpertsThreadsBoundEvt,
  ExpertsPhaseChanged,
  ExpertsExpertStatusChanged,
  ExpertsFindingPosted,
  ExpertsMessagePosted,
  ExpertsSynthesisSetEvt,
  ExpertsArchived,
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
