import { Type, type Static } from "typebox";
import { Activity, ApprovalDecision, CheckpointStats, ExpertSpec, ExpertsPhase, ImageInput, InteractionMode, Limited, LinkAccess, MergeStrategy, ProviderKind, PullRequest, RateLimit, RuntimeMode, Schedule, SettleReason, Team, Triage, TurnUsage, HandoffJudge, Verdict } from "./domain.ts";

// Commands = validated intents. ClientCommand may arrive over RPC; InternalCommand is
// issued only by server reactors (driver ingestion) and is rejected at the RPC boundary.

/**
 * Idempotency key any client or agent command may carry (R4): the engine keeps a receipt per
 * key and a retry returns the original result instead of re-running the decision. Clients mint
 * something unique (`newId()`), never a constant. (`turn.request.requestId` predates it and
 * additionally dedupes at the decider.)
 */
export const CommandId = Type.Optional(Type.String({ minLength: 1, maxLength: 128 }));

export const ProjectCreate = Type.Object({
  type: Type.Literal("project.create"), commandId: CommandId,
  title: Type.String({ minLength: 1 }),
  rootPath: Type.String({ minLength: 1 }),
});
export const ProjectUpdate = Type.Object({
  type: Type.Literal("project.update"), commandId: CommandId,
  projectId: Type.String(),
  title: Type.Optional(Type.String({ minLength: 1 })),
});
export const ProjectLinkAdd = Type.Object({
  type: Type.Literal("project.link.add"), commandId: CommandId,
  projectId: Type.String(),
  path: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  note: Type.Optional(Type.String()),
  access: Type.Optional(LinkAccess),
});
export const ProjectLinkUpdate = Type.Object({
  type: Type.Literal("project.link.update"), commandId: CommandId,
  projectId: Type.String(),
  linkId: Type.String(),
  label: Type.Optional(Type.String({ minLength: 1 })),
  note: Type.Optional(Type.String()),
  access: Type.Optional(LinkAccess),
});
export const ProjectLinkRemove = Type.Object({
  type: Type.Literal("project.link.remove"), commandId: CommandId,
  projectId: Type.String(),
  linkId: Type.String(),
});
export const ProjectArchive = Type.Object({ type: Type.Literal("project.archive"), commandId: CommandId, projectId: Type.String() });

export const ThreadCreate = Type.Object({
  type: Type.Literal("thread.create"), commandId: CommandId,
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
  type: Type.Literal("thread.update"), commandId: CommandId,
  threadId: Type.String(),
  title: Type.Optional(Type.String()),
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  interaction: Type.Optional(InteractionMode),
  pinned: Type.Optional(Type.Boolean()),
  /** R6: per-thread opt-in for auto-accepting routine approvals (judge-rated) */
  autoAllowRoutine: Type.Optional(Type.Boolean()),
  /** R7: false = the settlement reactor leaves this thread alone */
  autoSettle: Type.Optional(Type.Boolean()),
});
/** R5: bring an archived thread back (its worktree is not recreated; the branch is still there) */
export const ThreadUnarchive = Type.Object({ type: Type.Literal("thread.unarchive"), commandId: CommandId, threadId: Type.String() });
export const ProjectUnarchive = Type.Object({ type: Type.Literal("project.unarchive"), commandId: CommandId, projectId: Type.String() });
/**
 * R5: remove a thread for good — its turns, messages and activities leave the read model; the
 * server removes its worktree, its `tide/*` branch and its checkpoint refs. Refused while the
 * thread runs, while a live thread still descends from it or shares its worktree.
 */
export const ThreadDelete = Type.Object({
  type: Type.Literal("thread.delete"), commandId: CommandId,
  threadId: Type.String(),
  /** also delete every descendant (children, delegates, forks), deepest first; without it a thread with descendants is refused */
  cascade: Type.Optional(Type.Boolean()),
});
export const ThreadArchive = Type.Object({
  type: Type.Literal("thread.archive"), commandId: CommandId,
  threadId: Type.String(),
  /** default false: the worktree directory is removed (the branch is kept) */
  keepWorktree: Type.Optional(Type.Boolean()),
});
/** remove a thread's worktree directory now (branch kept unless deleteBranch) */
export const WorktreeDetach = Type.Object({
  type: Type.Literal("worktree.detach"), commandId: CommandId,
  threadId: Type.String(),
  deleteBranch: Type.Optional(Type.Boolean()),
});

/** While the thread is running the turn is queued and runs when the current one settles. */
export const TurnRequest = Type.Object({
  type: Type.Literal("turn.request"),
  threadId: Type.String(),
  text: Type.String({ minLength: 1 }),
  images: Type.Optional(Type.Array(ImageInput, { maxItems: 8 })),
  commandId: CommandId,
  /** idempotency key: a retry with the same id on the same thread is rejected with `conflict` */
  requestId: Type.Optional(Type.String({ minLength: 1 })),
  /** server-authored wake-ups (delegate done, child question, PR change, restart) are marked so the UI can render them as notices */
  notification: Type.Optional(Type.Object({ source: Type.Union([Type.Literal("delegate"), Type.Literal("child-question"), Type.Literal("pr"), Type.Literal("restart"), Type.Literal("system")]), summary: Type.String() })),
});
export const TurnInterrupt = Type.Object({ type: Type.Literal("turn.interrupt"), commandId: CommandId, threadId: Type.String() });
/** Drops a turn that is still queued (never sent to the harness). */
export const TurnDequeue = Type.Object({ type: Type.Literal("turn.dequeue"), commandId: CommandId, turnId: Type.String() });

export const ApprovalRespond = Type.Object({
  type: Type.Literal("approval.respond"), commandId: CommandId,
  threadId: Type.String(),
  requestId: Type.String(),
  decision: ApprovalDecision,
});
export const UserInputRespond = Type.Object({
  type: Type.Literal("user-input.respond"), commandId: CommandId,
  threadId: Type.String(),
  requestId: Type.String(),
  answers: Type.Record(Type.String(), Type.Unknown()),
});

/** Creates a sibling thread (any provider) seeded with the plan. The only way a plan runs. */
export const PlanImplement = Type.Object({
  type: Type.Literal("plan.implement"), commandId: CommandId,
  planId: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  useWorktree: Type.Optional(Type.Boolean()),
});
export const PlanDismiss = Type.Object({ type: Type.Literal("plan.dismiss"), commandId: CommandId, planId: Type.String() });

/** Commit everything in the worktree, push, open (or update) a PR via gh. */
export const ThreadPublish = Type.Object({
  type: Type.Literal("thread.publish"), commandId: CommandId,
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
  type: Type.Literal("thread.merge"), commandId: CommandId,
  threadId: Type.String(),
  strategy: Type.Optional(MergeStrategy),
  /** remove the tide/<slug> branch (and the worktree) once merged */
  deleteBranch: Type.Optional(Type.Boolean()),
});

// ---- R4: steer / queue editing / fork / rollback / limits / PR watch ----
/** Deliver a message into the running turn. Falls back to a queued turn when the harness cannot steer. */
export const TurnSteer = Type.Object({
  type: Type.Literal("turn.steer"),
  commandId: CommandId,
  threadId: Type.String(),
  text: Type.String({ minLength: 1 }),
  images: Type.Optional(Type.Array(ImageInput, { maxItems: 8 })),
});
/** Rewrite a turn that is still queued. */
export const TurnEdit = Type.Object({ type: Type.Literal("turn.edit"), commandId: CommandId, turnId: Type.String(), text: Type.String({ minLength: 1 }) });
/** New order of a thread's queued turns (every queued id exactly once). */
export const TurnReorder = Type.Object({ type: Type.Literal("turn.reorder"), commandId: CommandId, threadId: Type.String(), turnIds: Type.Array(Type.String(), { minItems: 1 }) });
/** Send a queued turn into the running one as a steer instead of waiting. */
export const TurnPromote = Type.Object({ type: Type.Literal("turn.promote"), commandId: CommandId, turnId: Type.String() });
/** New thread that continues this one from a settled turn (native fork when the harness can, portable handoff otherwise). */
export const ThreadFork = Type.Object({
  type: Type.Literal("thread.fork"),
  commandId: CommandId,
  threadId: Type.String(),
  turnId: Type.String(),
  title: Type.Optional(Type.String({ minLength: 1 })),
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  useWorktree: Type.Optional(Type.Boolean()),
});
/**
 * Undo `turnId` and everything after it: the harness forgets those turns (when it can) and,
 * with `restoreFiles`, the worktree goes back to the turn's before-checkpoint.
 */
export const ThreadRollback = Type.Object({
  type: Type.Literal("thread.rollback"),
  commandId: CommandId,
  threadId: Type.String(),
  turnId: Type.String(),
  restoreFiles: Type.Boolean(),
});
/** R7: close a thread from the inbox (worktree and branch untouched); `reason` is for the server's own settlements, clients send none. */
export const ThreadSettle = Type.Object({ type: Type.Literal("thread.settle"), commandId: CommandId, threadId: Type.String(), reason: Type.Optional(SettleReason) });
/** R7: undo a settle; also what the inbox's ⌘Z sends */
export const ThreadUnsettle = Type.Object({ type: Type.Literal("thread.unsettle"), commandId: CommandId, threadId: Type.String() });
/** Hide a thread from the Inbox / Now strip until `until` (or until it needs the user). */
export const ThreadSnooze = Type.Object({ type: Type.Literal("thread.snooze"), commandId: CommandId, threadId: Type.String(), until: Type.Number() });
/** Clear limited / snoozed state; with `continue` also asks the harness to pick up where it left off. */
export const ThreadResume = Type.Object({ type: Type.Literal("thread.resume"), commandId: CommandId, threadId: Type.String(), continue: Type.Optional(Type.Boolean()) });
/** Choose what happens when the harness reports its limit: wait for the user, or resume at reset. */
export const ThreadLimitPolicy = Type.Object({ type: Type.Literal("thread.limit-policy"), commandId: CommandId, threadId: Type.String(), resume: Limited.properties.resume });
/** Start/stop polling the thread's PR; a watched thread is woken on CI failure, new comments or conflicts. */
export const PrWatch = Type.Object({ type: Type.Literal("pr.watch"), commandId: CommandId, threadId: Type.String(), enabled: Type.Boolean() });

// ---- R4: scheduled tasks (client, and agents through agent.dispatch on their own project) ----
const taskFields = {
  threadId: Type.Optional(Type.String()),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  prompt: Type.String({ minLength: 1 }),
  schedule: Schedule,
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  useWorktree: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
};
export const TaskCreate = Type.Object({ type: Type.Literal("task.create"), commandId: CommandId, projectId: Type.String(), ...taskFields, createdByThreadId: Type.Optional(Type.String()) });
export const TaskUpdate = Type.Object({ type: Type.Literal("task.update"), commandId: CommandId, taskId: Type.String(), ...Type.Partial(Type.Object(taskFields)).properties });
export const TaskDelete = Type.Object({ type: Type.Literal("task.delete"), commandId: CommandId, taskId: Type.String() });
/** fire now, outside the schedule (does not move nextRunAt) */
export const TaskRunNow = Type.Object({ type: Type.Literal("task.run-now"), commandId: CommandId, taskId: Type.String() });
/** scheduler → engine: the tick fired this task; commandId is `scheduled:<taskId>:<epoch>` so a duplicate tick is a no-op */
export const TaskFire = Type.Object({ type: Type.Literal("task.fire"), commandId: CommandId, taskId: Type.String(), nextRunAt: Type.Optional(Type.Number()), useWorktreeDefault: Type.Optional(Type.Boolean()) });

/**
 * R5: start a team run — creates the lead thread (stage 1) on the project and sends it a brief
 * that tells it how to delegate the remaining stages. The server never runs stages itself.
 */
export const TeamRun = Type.Object({
  type: Type.Literal("team.run"),
  commandId: CommandId,
  projectId: Type.String(),
  team: Team,
  task: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  useWorktree: Type.Optional(Type.Boolean()),
});

// ---- experts (client) ----
export const ExpertsCreate = Type.Object({
  type: Type.Literal("experts.create"), commandId: CommandId,
  projectId: Type.String(),
  topic: Type.String({ minLength: 1 }),
  experts: Type.Array(ExpertSpec, { minItems: 1 }),
  lead: Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()) }),
});
/** spawns the expert + lead threads and kicks off the exploring phase */
export const ExpertsStart = Type.Object({ type: Type.Literal("experts.start"), commandId: CommandId, sessionId: Type.String() });
/** user contribution to the board (delivered to every expert as a message) */
export const ExpertsPost = Type.Object({ type: Type.Literal("experts.post"), commandId: CommandId, sessionId: Type.String(), text: Type.String({ minLength: 1 }), to: Type.Optional(Type.String()) });
export const ExpertsSetPhase = Type.Object({ type: Type.Literal("experts.set-phase"), commandId: CommandId, sessionId: Type.String(), phase: ExpertsPhase });
export const ExpertsArchive = Type.Object({ type: Type.Literal("experts.archive"), commandId: CommandId, sessionId: Type.String() });

export const ClientCommand = Type.Union([
  ProjectCreate, ProjectUpdate, ProjectArchive, ProjectUnarchive, ProjectLinkAdd, ProjectLinkUpdate, ProjectLinkRemove,
  ThreadCreate, ThreadUpdate, ThreadArchive, ThreadUnarchive, ThreadDelete,
  TurnRequest, TurnInterrupt, TurnDequeue,
  ApprovalRespond, UserInputRespond,
  PlanImplement, PlanDismiss,
  ThreadPublish, ThreadMerge, WorktreeDetach,
  TurnSteer, TurnEdit, TurnReorder, TurnPromote, ThreadFork, ThreadRollback, ThreadSnooze, ThreadResume, ThreadLimitPolicy, PrWatch, ThreadSettle, ThreadUnsettle,
  TaskCreate, TaskUpdate, TaskDelete, TaskRunNow, TeamRun,
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
/** R6: a decision-site reactor records a verdict on its target */
export const JudgeRecord = Type.Object({
  type: Type.Literal("judge.record"),
  target: Type.Object({ kind: Type.Union([Type.Literal("thread"), Type.Literal("approval"), Type.Literal("experts")]), id: Type.String() }),
  verdict: Verdict,
});
/** R6: the handoff judge replaces a pending handoff's selection; refused once the handoff was delivered */
export const HandoffRefine = Type.Object({
  type: Type.Literal("handoff.refine"),
  handoffId: Type.String(),
  text: Type.String(),
  coveredTurnIds: Type.Array(Type.String()),
  omittedTurnIds: Type.Array(Type.String()),
  judge: HandoffJudge,
});
/** provider reactor: the harness cannot steer (no cap, no live turn, or it refused) — the message becomes a queued turn instead */
export const SteerFallback = Type.Object({ type: Type.Literal("steer.fallback"), messageId: Type.String(), reason: Type.String() });
/** rollback service reports how a thread.rollback ended */
export const RollbackReport = Type.Object({
  type: Type.Literal("rollback.report"),
  threadId: Type.String(),
  outcome: Type.Union([Type.Literal("done"), Type.Literal("error")]),
  error: Type.Optional(Type.String()),
  /** the harness's session id after the rollback when it changed (Pi writes a new session file, Claude may re-mint) */
  nativeSessionId: Type.Optional(Type.String()),
});
/** provider reactor: the harness stopped because the subscription window is exhausted */
export const ThreadLimited = Type.Object({ type: Type.Literal("thread.limited"), threadId: Type.String(), resetsAt: Type.Optional(Type.Number()), note: Type.Optional(Type.String()) });
/** provider reactor: how the turn's handoff reached the harness */
export const HandoffDelivered = Type.Object({ type: Type.Literal("handoff.delivered"), turnId: Type.String(), delivery: Type.Union([Type.Literal("inline"), Type.Literal("native")]) });

// ---- agent-originated (via the Tide MCP server; authenticated per thread) ----
export const ExpertsFindingPost = Type.Object({ type: Type.Literal("experts.finding.post"), commandId: CommandId, sessionId: Type.String(), author: Type.String(), text: Type.String({ minLength: 1 }) });
export const ExpertsMessageSend = Type.Object({ type: Type.Literal("experts.message.send"), commandId: CommandId, sessionId: Type.String(), from: Type.String(), to: Type.String(), text: Type.String({ minLength: 1 }) });
export const ExpertsSynthesisSet = Type.Object({ type: Type.Literal("experts.synthesis.set"), commandId: CommandId, sessionId: Type.String(), markdown: Type.String({ minLength: 1 }) });
/** an agent asks Tide to run a task on another harness as a child thread */
export const ThreadDelegate = Type.Object({
  type: Type.Literal("thread.delegate"),
  commandId: CommandId,
  fromThreadId: Type.String(),
  /** R4: shapes the child's preamble (review / research / implementation …); free text, shown in the rail */
  role: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  title: Type.Optional(Type.String()),
  prompt: Type.String({ minLength: 1 }),
  useWorktree: Type.Optional(Type.Boolean()),
  /** W1: label of one of the calling project's links; the delegate runs with that repo as its main repo */
  repo: Type.Optional(Type.String({ minLength: 1 })),
  /** R5: run in another thread's worktree (a reviewer reading the implementer's branch); mutually exclusive with useWorktree/repo */
  inheritWorktreeFrom: Type.Optional(Type.String()),
});
export const ExpertsExpertStatus = Type.Object({
  type: Type.Literal("experts.expert.status"),
  sessionId: Type.String(),
  key: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("working"), Type.Literal("idle"), Type.Literal("error")]),
});

/** agents may manage their own project's automations; the RPC layer stamps projectId/createdByThreadId and scopes update/delete */
export const AgentCommand = Type.Union([ExpertsFindingPost, ExpertsMessageSend, ExpertsSynthesisSet, ThreadDelegate, TaskCreate, TaskUpdate, TaskDelete, TaskRunNow]);
export type AgentCommand = Static<typeof AgentCommand>;

export const InternalCommand = Type.Union([
  TurnStart, AssistantAppend, AssistantReasoningAppend, ActivityUpsert, PlanPropose, PlanProgressReport, UsageReport, TurnSettle,
  WorktreeAttach, CheckpointRecord, PrUpdate, WorktreeDetachedReport, MergeReport, ThreadTriage,
  SteerFallback, RollbackReport, ThreadLimited, HandoffDelivered, TaskFire,
  ExpertsExpertStatus, JudgeRecord, HandoffRefine,
]);
export type InternalCommand = Static<typeof InternalCommand>;

export const Command = Type.Union([ClientCommand, AgentCommand, InternalCommand]);
export type Command = Static<typeof Command>;
export type CommandOf<T extends Command["type"]> = Extract<Command, { type: T }>;

export const INTERNAL_COMMAND_TYPES: ReadonlySet<string> = new Set(InternalCommand.anyOf.map((s) => s.properties.type.const));
export function isInternalCommand(command: Command): command is InternalCommand {
  return INTERNAL_COMMAND_TYPES.has(command.type);
}
