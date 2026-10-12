import { Type, type Static } from "typebox";
import { Activity, ApprovalDecision, CheckpointStats, ExpertSpec, ExpertsPhase, ImageInput, InteractionMode, LinkAccess, MergeStrategy, ProviderKind, PullRequest, RateLimit, RuntimeMode, Triage, TurnUsage } from "./domain.ts";

// Commands = validated intents. ClientCommand may arrive over RPC; InternalCommand is
// issued only by server reactors (driver ingestion) and is rejected at the RPC boundary.

export const ProjectCreate = Type.Object({
  type: Type.Literal("project.create"),
  title: Type.String({ minLength: 1 }),
  rootPath: Type.String({ minLength: 1 }),
});
export const ProjectUpdate = Type.Object({
  type: Type.Literal("project.update"),
  projectId: Type.String(),
  title: Type.Optional(Type.String({ minLength: 1 })),
});
export const ProjectLinkAdd = Type.Object({
  type: Type.Literal("project.link.add"),
  projectId: Type.String(),
  path: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  note: Type.Optional(Type.String()),
  access: Type.Optional(LinkAccess),
});
export const ProjectLinkUpdate = Type.Object({
  type: Type.Literal("project.link.update"),
  projectId: Type.String(),
  linkId: Type.String(),
  label: Type.Optional(Type.String({ minLength: 1 })),
  note: Type.Optional(Type.String()),
  access: Type.Optional(LinkAccess),
});
export const ProjectLinkRemove = Type.Object({
  type: Type.Literal("project.link.remove"),
  projectId: Type.String(),
  linkId: Type.String(),
});
export const ProjectArchive = Type.Object({ type: Type.Literal("project.archive"), projectId: Type.String() });

export const ThreadCreate = Type.Object({
  type: Type.Literal("thread.create"),
  projectId: Type.String(),
  parentThreadId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  interaction: Type.Optional(InteractionMode),
  /** P2: create a git worktree for this thread */
  useWorktree: Type.Optional(Type.Boolean()),
  /** W1: per-thread link overrides; omitted = all project links with their default access */
  links: Type.Optional(Type.Array(Type.Object({ linkId: Type.String(), access: LinkAccess }))),
});
export const ThreadUpdate = Type.Object({
  type: Type.Literal("thread.update"),
  threadId: Type.String(),
  title: Type.Optional(Type.String()),
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  interaction: Type.Optional(InteractionMode),
});
export const ThreadArchive = Type.Object({
  type: Type.Literal("thread.archive"),
  threadId: Type.String(),
  /** default false: the worktree directory is removed (the branch is kept) */
  keepWorktree: Type.Optional(Type.Boolean()),
});
/** remove a thread's worktree directory now (branch kept unless deleteBranch) */
export const WorktreeDetach = Type.Object({
  type: Type.Literal("worktree.detach"),
  threadId: Type.String(),
  deleteBranch: Type.Optional(Type.Boolean()),
});

/** While the thread is running the turn is queued and runs when the current one settles. */
export const TurnRequest = Type.Object({
  type: Type.Literal("turn.request"),
  threadId: Type.String(),
  text: Type.String({ minLength: 1 }),
  images: Type.Optional(Type.Array(ImageInput, { maxItems: 8 })),
  /** idempotency key: a retry with the same id on the same thread is rejected with `conflict` */
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});
export const TurnInterrupt = Type.Object({ type: Type.Literal("turn.interrupt"), threadId: Type.String() });
/** Drops a turn that is still queued (never sent to the harness). */
export const TurnDequeue = Type.Object({ type: Type.Literal("turn.dequeue"), turnId: Type.String() });

export const ApprovalRespond = Type.Object({
  type: Type.Literal("approval.respond"),
  threadId: Type.String(),
  requestId: Type.String(),
  decision: ApprovalDecision,
});
export const UserInputRespond = Type.Object({
  type: Type.Literal("user-input.respond"),
  threadId: Type.String(),
  requestId: Type.String(),
  answers: Type.Record(Type.String(), Type.Unknown()),
});

/** Creates a sibling thread (any provider) seeded with the plan. The only way a plan runs. */
export const PlanImplement = Type.Object({
  type: Type.Literal("plan.implement"),
  planId: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  useWorktree: Type.Optional(Type.Boolean()),
});
export const PlanDismiss = Type.Object({ type: Type.Literal("plan.dismiss"), planId: Type.String() });

/** Restore the worktree to the state before `turnId` (git checkout of the before-ref). */
export const ThreadRevert = Type.Object({ type: Type.Literal("thread.revert"), threadId: Type.String(), turnId: Type.String() });
/** Commit everything in the worktree, push, open (or update) a PR via gh. */
export const ThreadPublish = Type.Object({
  type: Type.Literal("thread.publish"),
  threadId: Type.String(),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  /** commit only, no push/PR */
  commitOnly: Type.Optional(Type.Boolean()),
  /** after opening the PR, enable auto-merge (`gh pr merge --auto`) with this strategy */
  mergeWhenGreen: Type.Optional(MergeStrategy),
});
/** Merge the thread's branch back into its base branch (locally, or via `gh pr merge` when a PR exists). */
export const ThreadMerge = Type.Object({
  type: Type.Literal("thread.merge"),
  threadId: Type.String(),
  strategy: Type.Optional(MergeStrategy),
  /** remove the tide/<slug> branch (and the worktree) once merged */
  deleteBranch: Type.Optional(Type.Boolean()),
});

// ---- experts (client) ----
export const ExpertsCreate = Type.Object({
  type: Type.Literal("experts.create"),
  projectId: Type.String(),
  topic: Type.String({ minLength: 1 }),
  experts: Type.Array(ExpertSpec, { minItems: 1 }),
  lead: Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()) }),
});
/** spawns the expert + lead threads and kicks off the exploring phase */
export const ExpertsStart = Type.Object({ type: Type.Literal("experts.start"), sessionId: Type.String() });
/** user contribution to the board (delivered to every expert as a message) */
export const ExpertsPost = Type.Object({ type: Type.Literal("experts.post"), sessionId: Type.String(), text: Type.String({ minLength: 1 }), to: Type.Optional(Type.String()) });
export const ExpertsSetPhase = Type.Object({ type: Type.Literal("experts.set-phase"), sessionId: Type.String(), phase: ExpertsPhase });
export const ExpertsArchive = Type.Object({ type: Type.Literal("experts.archive"), sessionId: Type.String() });

export const ClientCommand = Type.Union([
  ProjectCreate, ProjectUpdate, ProjectArchive, ProjectLinkAdd, ProjectLinkUpdate, ProjectLinkRemove,
  ThreadCreate, ThreadUpdate, ThreadArchive,
  TurnRequest, TurnInterrupt, TurnDequeue,
  ApprovalRespond, UserInputRespond,
  PlanImplement, PlanDismiss,
  ThreadRevert, ThreadPublish, ThreadMerge, WorktreeDetach,
  ExpertsCreate, ExpertsStart, ExpertsPost, ExpertsSetPhase, ExpertsArchive,
]);
export type ClientCommand = Static<typeof ClientCommand>;

// ---- internal (reactor → engine) ----
export const TurnStart = Type.Object({
  type: Type.Literal("turn.start"),
  turnId: Type.String(),
  nativeSessionId: Type.Optional(Type.String()),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
});
export const AssistantAppend = Type.Object({
  type: Type.Literal("assistant.append"),
  turnId: Type.String(),
  messageId: Type.String(),
  delta: Type.String(),
});
export const AssistantReasoningAppend = Type.Object({
  type: Type.Literal("assistant.reasoning.append"),
  turnId: Type.String(),
  messageId: Type.String(),
  delta: Type.String(),
});
export const ActivityUpsert = Type.Object({ type: Type.Literal("activity.upsert"), activity: Activity });
export const PlanPropose = Type.Object({
  type: Type.Literal("plan.propose"),
  turnId: Type.String(),
  markdown: Type.String(),
});
export const PlanProgressReport = Type.Object({
  type: Type.Literal("plan.progress"),
  threadId: Type.String(),
  steps: Type.Array(Type.Object({ text: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) })),
});
export const UsageReport = Type.Object({
  type: Type.Literal("usage.report"),
  turnId: Type.String(),
  usage: Type.Optional(TurnUsage),
  contextUsage: Type.Optional(Type.Object({ used: Type.Number(), window: Type.Number() })),
  rateLimit: Type.Optional(RateLimit),
});
export const TurnSettle = Type.Object({
  type: Type.Literal("turn.settle"),
  turnId: Type.String(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("interrupted"), Type.Literal("error")]),
  error: Type.Optional(Type.String()),
});

export const WorktreeAttach = Type.Object({
  type: Type.Literal("worktree.attach"),
  threadId: Type.String(),
  worktreePath: Type.String(),
  branch: Type.String(),
  baseBranch: Type.Optional(Type.String()),
});
export const CheckpointRecord = Type.Object({
  type: Type.Literal("checkpoint.record"),
  turnId: Type.String(),
  phase: Type.Union([Type.Literal("before"), Type.Literal("after")]),
  ref: Type.String(),
  stats: Type.Optional(CheckpointStats),
});
export const PrUpdate = Type.Object({ type: Type.Literal("pr.update"), threadId: Type.String(), pr: PullRequest });
/** vcs reactor reports that a thread's worktree directory is gone */
export const WorktreeDetachedReport = Type.Object({ type: Type.Literal("worktree.detached"), threadId: Type.String() });
/** vcs reactor reports how a thread.merge ended */
export const MergeReport = Type.Object({
  type: Type.Literal("merge.report"),
  threadId: Type.String(),
  outcome: Type.Union([Type.Literal("merged"), Type.Literal("conflicted"), Type.Literal("error")]),
  sha: Type.Optional(Type.String()),
  files: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  branchDeleted: Type.Optional(Type.Boolean()),
});
/** triage reactor reports the decisions model's answers for a thread */
export const ThreadTriage = Type.Object({ type: Type.Literal("thread.triage"), threadId: Type.String(), triage: Triage });

// ---- agent-originated (via the Tide MCP server; authenticated per thread) ----
export const ExpertsFindingPost = Type.Object({ type: Type.Literal("experts.finding.post"), sessionId: Type.String(), author: Type.String(), text: Type.String({ minLength: 1 }) });
export const ExpertsMessageSend = Type.Object({ type: Type.Literal("experts.message.send"), sessionId: Type.String(), from: Type.String(), to: Type.String(), text: Type.String({ minLength: 1 }) });
export const ExpertsSynthesisSet = Type.Object({ type: Type.Literal("experts.synthesis.set"), sessionId: Type.String(), markdown: Type.String({ minLength: 1 }) });
/** an agent asks Tide to run a task on another harness as a child thread */
export const ThreadDelegate = Type.Object({
  type: Type.Literal("thread.delegate"),
  fromThreadId: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  title: Type.Optional(Type.String()),
  prompt: Type.String({ minLength: 1 }),
  useWorktree: Type.Optional(Type.Boolean()),
  /** W1: label of one of the calling project's links; the delegate runs with that repo as its main repo */
  repo: Type.Optional(Type.String({ minLength: 1 })),
});
export const ExpertsExpertStatus = Type.Object({
  type: Type.Literal("experts.expert.status"),
  sessionId: Type.String(),
  key: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("working"), Type.Literal("idle"), Type.Literal("error")]),
});

export const AgentCommand = Type.Union([ExpertsFindingPost, ExpertsMessageSend, ExpertsSynthesisSet, ThreadDelegate]);
export type AgentCommand = Static<typeof AgentCommand>;

export const InternalCommand = Type.Union([
  TurnStart, AssistantAppend, AssistantReasoningAppend, ActivityUpsert, PlanPropose, PlanProgressReport, UsageReport, TurnSettle,
  WorktreeAttach, CheckpointRecord, PrUpdate, WorktreeDetachedReport, MergeReport, ThreadTriage,
  ExpertsExpertStatus,
]);
export type InternalCommand = Static<typeof InternalCommand>;

export const Command = Type.Union([ClientCommand, AgentCommand, InternalCommand]);
export type Command = Static<typeof Command>;
export type CommandOf<T extends Command["type"]> = Extract<Command, { type: T }>;

export const INTERNAL_COMMAND_TYPES: ReadonlySet<string> = new Set(InternalCommand.anyOf.map((s) => s.properties.type.const));
export function isInternalCommand(command: Command): command is InternalCommand {
  return INTERNAL_COMMAND_TYPES.has(command.type);
}
