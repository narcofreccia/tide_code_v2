import { Type, type Static } from "typebox";
import { Activity, ApprovalDecision, CheckpointStats, ExpertsFinding, ExpertsMessage, ExpertsPhase, ExpertsSession, Handoff, ImageInput, Limited, MergeStrategy, Message, Project, ProjectLink, ProposedPlan, ProviderKind, PullRequest, RateLimit, ScheduledTask, SettleReason, Thread, Triage, Turn, TurnUsage, HandoffJudge, Verdict, ProjectIcon } from "./domain.ts";

// Events = persisted facts. Payloads are self-contained so the projector
// never needs to look anything up outside the event.

const evt = <T extends string, P extends Parameters<typeof Type.Object>[0]>(type: T, props: P) =>
  Type.Object({ type: Type.Literal(type), ...props });

export const ProjectCreated = evt("project.created", { project: Project });
export const ProjectUpdated = evt("project.updated", {
  projectId: Type.String(),
  title: Type.Optional(Type.String()),
  /** R11 */
  icon: Type.Optional(ProjectIcon),
  clearIcon: Type.Optional(Type.Boolean()),
  updatedAt: Type.Number(),
});
export const ProjectArchived = evt("project.archived", { projectId: Type.String(), archivedAt: Type.Number() });
export const ProjectLinkAdded = evt("project.link.added", { projectId: Type.String(), link: ProjectLink, updatedAt: Type.Number() });
export const ProjectLinkUpdated = evt("project.link.updated", { projectId: Type.String(), link: ProjectLink, updatedAt: Type.Number() });
export const ProjectLinkRemoved = evt("project.link.removed", { projectId: Type.String(), linkId: Type.String(), updatedAt: Type.Number() });

/** `useWorktree` is an intent for the vcs reactor, not state; the reactor answers with worktree.attached. */
export const ThreadCreated = evt("thread.created", {
  thread: Thread,
  useWorktree: Type.Optional(Type.Boolean()),
  /** R4: branch the worktree from this ref instead of the base branch (a fork continues its source's work) */
  baseRef: Type.Optional(Type.String()),
});
export const ThreadUpdated = evt("thread.updated", {
  threadId: Type.String(),
  patch: Type.Partial(Type.Pick(Thread, ["title", "provider", "model", "mode", "interaction", "pinned", "autoAllowRoutine", "autoSettle", "providerId", "effort"])),
  /** R5: the title was derived from the first prompt, not typed by the user */
  autoTitled: Type.Optional(Type.Boolean()),
  /** the provider changed: the old harness's session id must not be resumed on the new one */
  clearNativeSession: Type.Optional(Type.Boolean()),
  /** R4: switching back to a harness that already ran this thread: its own session id becomes current again */
  nativeSessionId: Type.Optional(Type.String()),
  /** the provider changed and no model was named: the old harness's model id must not be sent to the new one */
  clearModel: Type.Optional(Type.Boolean()),
  /** R8: effort reset to the harness default */
  clearEffort: Type.Optional(Type.Boolean()),
  updatedAt: Type.Number(),
});
export const ThreadArchived = evt("thread.archived", { threadId: Type.String(), archivedAt: Type.Number(), keepWorktree: Type.Optional(Type.Boolean()) });
export const ThreadUnarchived = evt("thread.unarchived", { threadId: Type.String(), at: Type.Number() });
/** self-contained: the projector drops the thread, so reactors read the paths from here */
export const ThreadDeleted = evt("thread.deleted", {
  threadId: Type.String(),
  projectId: Type.String(),
  worktreePath: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  at: Type.Number(),
});
export const ProjectUnarchived = evt("project.unarchived", { projectId: Type.String(), at: Type.Number() });

/** `turn.status` is `queued` when another turn of the thread is still running. Image bytes live
 *  only here (the projector keeps metadata on the message); the provider reactor reads them. */
export const TurnRequested = evt("turn.requested", { turn: Turn, userMessage: Message, images: Type.Optional(Type.Array(ImageInput)) });
export const TurnDequeued = evt("turn.dequeued", { turnId: Type.String(), threadId: Type.String(), at: Type.Number() });
export const TurnStarted = evt("turn.started", {
  turnId: Type.String(),
  threadId: Type.String(),
  provider: ProviderKind,
  /** R8: instance id; `providerSessions` is keyed by `providerId ?? provider` */
  providerId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  nativeSessionId: Type.Optional(Type.String()),
  startedAt: Type.Number(),
});
export const TurnInterruptRequested = evt("turn.interrupt-requested", { turnId: Type.String(), threadId: Type.String(), at: Type.Number() });
export const ActivityUpserted = evt("activity.upserted", { activity: Activity });
/** `activityId` pins the exact pending activity (requestIds repeat across harness processes). */
export const ApprovalResponded = evt("approval.responded", {
  threadId: Type.String(),
  requestId: Type.String(),
  activityId: Type.Optional(Type.String()),
  decision: ApprovalDecision,
  at: Type.Number(),
});
export const UserInputResponded = evt("user-input.responded", {
  threadId: Type.String(),
  requestId: Type.String(),
  activityId: Type.Optional(Type.String()),
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
export const PublishRequested = evt("publish.requested", {
  threadId: Type.String(),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  commitOnly: Type.Optional(Type.Boolean()),
  mergeWhenGreen: Type.Optional(MergeStrategy),
  at: Type.Number(),
});
export const MergeRequested = evt("merge.requested", { threadId: Type.String(), strategy: MergeStrategy, deleteBranch: Type.Optional(Type.Boolean()), at: Type.Number() });
export const MergeCompleted = evt("merge.completed", { threadId: Type.String(), strategy: MergeStrategy, sha: Type.Optional(Type.String()), branchDeleted: Type.Optional(Type.Boolean()), at: Type.Number() });
export const MergeConflicted = evt("merge.conflicted", { threadId: Type.String(), strategy: MergeStrategy, files: Type.Array(Type.String()), at: Type.Number() });
export const MergeFailed = evt("merge.failed", { threadId: Type.String(), strategy: MergeStrategy, error: Type.String(), at: Type.Number() });
export const ThreadTriaged = evt("thread.triaged", { threadId: Type.String(), triage: Triage });
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
  rateLimit: Type.Optional(RateLimit),
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

// ---- R4 ----
/** A user message delivered into the running turn (or queued behind it when the harness cannot steer). */
export const TurnSteered = evt("turn.steered", { turnId: Type.String(), threadId: Type.String(), message: Message, images: Type.Optional(Type.Array(ImageInput)) });
/** The harness could not take the steer: the message leaves the running turn and becomes a queued turn. */
export const TurnSteerFellBack = evt("turn.steer-fell-back", { threadId: Type.String(), messageId: Type.String(), reason: Type.String(), turn: Turn, userMessage: Message, images: Type.Optional(Type.Array(ImageInput)), at: Type.Number() });
export const TurnEdited = evt("turn.edited", { turnId: Type.String(), threadId: Type.String(), messageId: Type.String(), text: Type.String(), at: Type.Number() });
/** `requestedAt` of each queued turn is rewritten so the projector's oldest-first promotion follows the new order. */
export const TurnsReordered = evt("turns.reordered", { threadId: Type.String(), turnIds: Type.Array(Type.String()), at: Type.Number() });
/** Context carried to a harness that has not seen the thread (recorded before the turn that consumes it). */
export const HandoffRecorded = evt("handoff.recorded", { handoff: Handoff });
/** R6: the judge re-ranked the handoff; replaces text/coverage of a not-yet-delivered handoff */
export const HandoffRefined = evt("handoff.refined", {
  handoffId: Type.String(),
  threadId: Type.String(),
  text: Type.String(),
  coveredTurnIds: Type.Array(Type.String()),
  omittedTurnIds: Type.Array(Type.String()),
  judge: HandoffJudge,
  at: Type.Number(),
});
/** R6: a verdict landed on a thread, an approval activity or an experts session */
export const JudgeRecorded = evt("judge.recorded", {
  target: Type.Object({ kind: Type.Union([Type.Literal("thread"), Type.Literal("approval"), Type.Literal("experts")]), id: Type.String() }),
  verdict: Verdict,
});
export const HandoffDeliveredEvt = evt("handoff.delivered", { turnId: Type.String(), threadId: Type.String(), handoffId: Type.String(), delivery: Type.Union([Type.Literal("inline"), Type.Literal("native")]), at: Type.Number() });
/** `turns` = how many of the harness's own turns to forget (the rolled-back ones that it ran). */
export const RollbackRequested = evt("rollback.requested", { threadId: Type.String(), turnId: Type.String(), restoreFiles: Type.Boolean(), turnIds: Type.Array(Type.String()), at: Type.Number() });
export const RollbackCompleted = evt("rollback.completed", { threadId: Type.String(), turnId: Type.String(), turnIds: Type.Array(Type.String()), provider: ProviderKind, nativeSessionId: Type.Optional(Type.String()), at: Type.Number() });
export const RollbackFailed = evt("rollback.failed", { threadId: Type.String(), turnId: Type.String(), error: Type.String(), at: Type.Number() });
export const ThreadLimitedEvt = evt("thread.limited", { threadId: Type.String(), limited: Limited });
export const ThreadLimitPolicyChanged = evt("thread.limit-policy-changed", { threadId: Type.String(), resume: Limited.properties.resume, at: Type.Number() });
export const ThreadSettled = evt("thread.settled", { threadId: Type.String(), reason: SettleReason, at: Type.Number() });
export const ThreadUnsettled = evt("thread.unsettled", { threadId: Type.String(), at: Type.Number() });
export const ThreadSnoozed = evt("thread.snoozed", { threadId: Type.String(), until: Type.Number(), at: Type.Number() });
/** limited / snoozed cleared (a continuation turn, when asked, rides along as its own turn.requested) */
export const ThreadResumed = evt("thread.resumed", { threadId: Type.String(), at: Type.Number() });
export const PrWatchChanged = evt("pr.watch-changed", { threadId: Type.String(), enabled: Type.Boolean(), at: Type.Number() });
export const TaskCreated = evt("task.created", { task: ScheduledTask });
export const TaskUpdated = evt("task.updated", { taskId: Type.String(), patch: Type.Partial(Type.Omit(ScheduledTask, ["id", "projectId", "createdAt", "runs", "lastRunAt", "lastRunThreadId", "archivedAt"])), updatedAt: Type.Number() });
export const TaskDeleted = evt("task.deleted", { taskId: Type.String(), at: Type.Number() });
/** the fire itself; the thread/turn it produced ride along as their own events in the same commit */
export const TaskFired = evt("task.fired", { taskId: Type.String(), threadId: Type.String(), turnId: Type.String(), nextRunAt: Type.Optional(Type.Number()), at: Type.Number() });

export const DomainEvent = Type.Union([
  ProjectCreated,
  ProjectUpdated,
  ProjectArchived, ProjectLinkAdded, ProjectLinkUpdated, ProjectLinkRemoved,
  ThreadCreated,
  ThreadUpdated,
  ThreadArchived,
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
  ThreadUnarchived, ProjectUnarchived, ThreadDeleted,
  PublishRequested,
  MergeRequested,
  MergeCompleted,
  MergeConflicted,
  MergeFailed,
  ThreadTriaged,
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
  TurnSteered, TurnSteerFellBack, TurnEdited, TurnsReordered,
  HandoffRecorded, HandoffDeliveredEvt, HandoffRefined, JudgeRecorded,
  RollbackRequested, RollbackCompleted, RollbackFailed,
  ThreadLimitedEvt, ThreadLimitPolicyChanged, ThreadSnoozed, ThreadResumed, PrWatchChanged, ThreadSettled, ThreadUnsettled,
  TaskCreated, TaskUpdated, TaskDeleted, TaskFired,
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
