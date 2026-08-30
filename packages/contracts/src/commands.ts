import { Type, type Static } from "typebox";
import { Activity, ApprovalDecision, CheckpointStats, InteractionMode, ProviderKind, PullRequest, RuntimeMode, TurnUsage } from "./domain.ts";

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
export const ThreadArchive = Type.Object({ type: Type.Literal("thread.archive"), threadId: Type.String() });

export const TurnRequest = Type.Object({
  type: Type.Literal("turn.request"),
  threadId: Type.String(),
  text: Type.String({ minLength: 1 }),
});
export const TurnInterrupt = Type.Object({ type: Type.Literal("turn.interrupt"), threadId: Type.String() });

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
});

export const ClientCommand = Type.Union([
  ProjectCreate, ProjectUpdate, ProjectArchive,
  ThreadCreate, ThreadUpdate, ThreadArchive,
  TurnRequest, TurnInterrupt,
  ApprovalRespond, UserInputRespond,
  PlanImplement, PlanDismiss,
  ThreadRevert, ThreadPublish,
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

export const InternalCommand = Type.Union([
  TurnStart, AssistantAppend, ActivityUpsert, PlanPropose, PlanProgressReport, UsageReport, TurnSettle,
  WorktreeAttach, CheckpointRecord, PrUpdate,
]);
export type InternalCommand = Static<typeof InternalCommand>;

export const Command = Type.Union([ClientCommand, InternalCommand]);
export type Command = Static<typeof Command>;
export type CommandOf<T extends Command["type"]> = Extract<Command, { type: T }>;

export const INTERNAL_COMMAND_TYPES: ReadonlySet<string> = new Set(InternalCommand.anyOf.map((s) => s.properties.type.const));
export function isInternalCommand(command: Command): command is InternalCommand {
  return INTERNAL_COMMAND_TYPES.has(command.type);
}
