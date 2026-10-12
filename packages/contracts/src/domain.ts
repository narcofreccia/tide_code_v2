import { Type, type Static } from "typebox";

// ---- vocabularies (mirrors T3's so we can map every harness onto them) ----
export const ProviderKind = Type.Union([
  Type.Literal("claude"),
  Type.Literal("codex"),
  Type.Literal("opencode"),
  Type.Literal("pi"),
]);
export type ProviderKind = Static<typeof ProviderKind>;

/** Tide-level permission mode; each driver maps it to its native knobs. */
export const RuntimeMode = Type.Union([
  Type.Literal("approval-required"),
  Type.Literal("auto-accept-edits"),
  Type.Literal("auto"),
  Type.Literal("full-access"),
]);
export type RuntimeMode = Static<typeof RuntimeMode>;

/** default = build; plan = harness-native plan mode producing a ProposedPlan. */
export const InteractionMode = Type.Union([Type.Literal("default"), Type.Literal("plan")]);
export type InteractionMode = Static<typeof InteractionMode>;

export const ThreadStatus = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("interrupted"),
  Type.Literal("error"),
]);
export type ThreadStatus = Static<typeof ThreadStatus>;

/** Why a thread needs the user (drives the ◐ glyph and the Inbox). Derived by the projector. */
export const AttentionKind = Type.Union([Type.Literal("approval"), Type.Literal("question"), Type.Literal("plan")]);
export type AttentionKind = Static<typeof AttentionKind>;

export const TurnStatus = Type.Union([
  /** waiting behind a running turn of the same thread; promoted to requested when it settles */
  Type.Literal("queued"),
  Type.Literal("requested"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("interrupted"),
  Type.Literal("error"),
]);
export type TurnStatus = Static<typeof TurnStatus>;

export const ApprovalDecision = Type.Union([
  Type.Literal("accept"),
  Type.Literal("acceptForSession"),
  Type.Literal("acceptAlways"),
  Type.Literal("decline"),
  Type.Literal("cancel"),
]);
export type ApprovalDecision = Static<typeof ApprovalDecision>;

// ---- read-model entities ----
/** A secondary repository a project's threads may reach (Claude Code's `--add-dir` made durable).
 *  `access` is the default for new threads; `note` is a one-line description injected into the
 *  agent's preamble so it knows what the folder *is*. */
export const LinkAccess = Type.Union([Type.Literal("read"), Type.Literal("write")]);
export type LinkAccess = Static<typeof LinkAccess>;
export const ProjectLink = Type.Object({
  id: Type.String(),
  path: Type.String(),
  label: Type.String(),
  note: Type.Optional(Type.String()),
  access: LinkAccess,
});
export type ProjectLink = Static<typeof ProjectLink>;

export const Project = Type.Object({
  id: Type.String(),
  title: Type.String(),
  rootPath: Type.String(),
  links: Type.Optional(Type.Array(ProjectLink)),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  archivedAt: Type.Optional(Type.Number()),
});
export type Project = Static<typeof Project>;

// ---- Experts: a cross-harness brainstorming session. Each expert is an ordinary thread
// (any provider); they talk through a server-mediated board exposed as MCP tools. ----
export const ExpertsPhase = Type.Union([
  Type.Literal("setup"),
  Type.Literal("exploring"),
  Type.Literal("discussing"),
  Type.Literal("synthesizing"),
  Type.Literal("ready"),
  Type.Literal("archived"),
]);
export type ExpertsPhase = Static<typeof ExpertsPhase>;

export const ExpertSpec = Type.Object({
  key: Type.String(),
  name: Type.String(),
  role: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  /** persona instructions appended to the expert's first prompt */
  persona: Type.Optional(Type.String()),
});
export type ExpertSpec = Static<typeof ExpertSpec>;

export const ExpertState = Type.Object({
  ...ExpertSpec.properties,
  threadId: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal("pending"), Type.Literal("working"), Type.Literal("idle"), Type.Literal("error")]),
});
export type ExpertState = Static<typeof ExpertState>;

export const ExpertsFinding = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  /** expert key, "lead", or "user" */
  author: Type.String(),
  text: Type.String(),
  createdAt: Type.Number(),
});
export type ExpertsFinding = Static<typeof ExpertsFinding>;

export const ExpertsMessage = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  from: Type.String(),
  /** expert key, "lead", or "all" */
  to: Type.String(),
  text: Type.String(),
  createdAt: Type.Number(),
});
export type ExpertsMessage = Static<typeof ExpertsMessage>;

export const ExpertsSession = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  topic: Type.String(),
  phase: ExpertsPhase,
  experts: Type.Array(ExpertState),
  lead: Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()), threadId: Type.Optional(Type.String()) }),
  findingIds: Type.Array(Type.String()),
  messageIds: Type.Array(Type.String()),
  synthesis: Type.Optional(Type.Object({ markdown: Type.String(), planId: Type.Optional(Type.String()), at: Type.Number() })),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type ExpertsSession = Static<typeof ExpertsSession>;

/** Subscription / API rate-limit status as the harness reports it (Claude rate_limit_event, Codex account/rateLimits). */
export const RateLimit = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("warning"), Type.Literal("limited")]),
  /** 0..100, share of the window still available when the harness says */
  remainingPct: Type.Optional(Type.Number()),
  resetsAt: Type.Optional(Type.Number()),
  overage: Type.Optional(Type.Boolean()),
  /** harness wording, shown verbatim */
  note: Type.Optional(Type.String()),
  at: Type.Number(),
});
export type RateLimit = Static<typeof RateLimit>;

export const MergeStrategy = Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]);
export type MergeStrategy = Static<typeof MergeStrategy>;
/** Outcome of the last `thread.merge` (merge-back of the thread's branch into its base). */
export const MergeState = Type.Object({
  status: Type.Union([Type.Literal("merging"), Type.Literal("merged"), Type.Literal("conflicted"), Type.Literal("error")]),
  strategy: MergeStrategy,
  /** files in conflict when status = conflicted */
  files: Type.Optional(Type.Array(Type.String())),
  sha: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  at: Type.Number(),
});
export type MergeState = Static<typeof MergeState>;

/** Calibrated triage answers (0..1 probabilities, urgency 0..1) from the optional decisions model. Never acted on automatically. */
export const Triage = Type.Object({
  needsUser: Type.Number(),
  stuck: Type.Number(),
  urgency: Type.Number(),
  at: Type.Number(),
});
export type Triage = Static<typeof Triage>;

export const PullRequest = Type.Object({
  url: Type.String(),
  number: Type.Number(),
  state: Type.Union([Type.Literal("open"), Type.Literal("merged"), Type.Literal("closed")]),
  updatedAt: Type.Number(),
});
export type PullRequest = Static<typeof PullRequest>;

export const Thread = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  parentThreadId: Type.Optional(Type.String()),
  title: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: RuntimeMode,
  interaction: InteractionMode,
  /** set when the thread belongs to an Experts session or was delegated by another thread */
  role: Type.Optional(Type.Union([Type.Literal("expert"), Type.Literal("lead"), Type.Literal("delegate")])),
  expertsSessionId: Type.Optional(Type.String()),
  /** thread that created this one via tide_delegate */
  delegatedBy: Type.Optional(Type.String()),
  worktreePath: Type.Optional(Type.String()),
  /** linked repos this thread can reach, resolved at creation from the project's links (per-thread overrides) */
  links: Type.Optional(Type.Array(Type.Object({ linkId: Type.String(), access: LinkAccess }))),
  branch: Type.Optional(Type.String()),
  /** branch the worktree was forked from (merge/PR base) */
  baseBranch: Type.Optional(Type.String()),
  pr: Type.Optional(PullRequest),
  status: ThreadStatus,
  /** an interrupt was requested and the harness has not settled yet */
  interrupting: Type.Optional(Type.Boolean()),
  attention: Type.Optional(AttentionKind),
  latestTurnId: Type.Optional(Type.String()),
  /** the harness's own session id (claude session_id, codex threadId, …) for resume / open-in-terminal */
  nativeSessionId: Type.Optional(Type.String()),
  /** live plan/todo progress reported by the harness during a turn */
  planProgress: Type.Optional(Type.Object({ steps: Type.Array(Type.Object({ text: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) })), updatedAt: Type.Number() })),
  contextUsage: Type.Optional(Type.Object({ used: Type.Number(), window: Type.Number() })),
  /** sum of per-turn costUsd deltas (usage.reported carries deltas, never cumulative figures) */
  totalCostUsd: Type.Optional(Type.Number()),
  rateLimit: Type.Optional(RateLimit),
  merge: Type.Optional(MergeState),
  /** set once the thread's branch landed on its base (locally or via the PR) */
  mergedAt: Type.Optional(Type.Number()),
  triage: Type.Optional(Triage),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  archivedAt: Type.Optional(Type.Number()),
});
export type Thread = Static<typeof Thread>;

export const MessageRole = Type.Union([Type.Literal("user"), Type.Literal("assistant")]);
export type MessageRole = Static<typeof MessageRole>;

export const Message = Type.Object({
  id: Type.String(),
  threadId: Type.String(),
  turnId: Type.String(),
  role: MessageRole,
  text: Type.String(),
  /** extended-thinking / reasoning that preceded `text` (assistant only) */
  reasoning: Type.Optional(Type.String()),
  /** image attachments (user only). Metadata only — the bytes ride on the turn.requested event. */
  attachments: Type.Optional(Type.Array(Type.Object({ mediaType: Type.String(), bytes: Type.Number() }))),
  createdAt: Type.Number(),
  /** true while the assistant is still streaming into this message */
  streaming: Type.Optional(Type.Boolean()),
});
export type Message = Static<typeof Message>;

/** A base64 image handed to the harness with the prompt. */
export const ImageInput = Type.Object({ mediaType: Type.String(), data: Type.String() });
export type ImageInput = Static<typeof ImageInput>;

/** Always a delta for the report it rides on; the projector sums reports into Turn.usage. */
export const TurnUsage = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  cacheWriteTokens: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
});
export type TurnUsage = Static<typeof TurnUsage>;

export const CheckpointStats = Type.Object({ files: Type.Number(), additions: Type.Number(), deletions: Type.Number() });
export type CheckpointStats = Static<typeof CheckpointStats>;
/** Git refs recorded around a turn: refs/tide/checkpoints/<thread>/<turn>/{before,after}. */
export const Checkpoint = Type.Object({
  before: Type.String(),
  after: Type.Optional(Type.String()),
  stats: Type.Optional(CheckpointStats),
});
export type Checkpoint = Static<typeof Checkpoint>;

export const Turn = Type.Object({
  id: Type.String(),
  threadId: Type.String(),
  status: TurnStatus,
  /** client idempotency key from turn.request; a repeat on the same thread is rejected */
  requestId: Type.Optional(Type.String()),
  checkpoint: Type.Optional(Checkpoint),
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  requestedAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  settledAt: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
  usage: Type.Optional(TurnUsage),
});
export type Turn = Static<typeof Turn>;

// ---- activities: everything in the stream that is not a message ----
const ActivityBase = {
  id: Type.String(),
  threadId: Type.String(),
  turnId: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  /** set when produced inside a harness sub-agent; groups rows under the child */
  parentToolUseId: Type.Optional(Type.String()),
};
export const ToolActivity = Type.Object({
  ...ActivityBase,
  kind: Type.Literal("tool"),
  toolUseId: Type.String(),
  toolName: Type.String(),
  input: Type.Unknown(),
  status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error")]),
  /** truncated text rendering of the result */
  output: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number()),
});
export const ApprovalActivity = Type.Object({
  ...ActivityBase,
  kind: Type.Literal("approval"),
  requestId: Type.String(),
  toolName: Type.String(),
  input: Type.Unknown(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  /** unified diff when the tool is a file edit */
  diff: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal("pending"), Type.Literal("resolved")]),
  decision: Type.Optional(ApprovalDecision),
});
export const UserInputQuestion = Type.Object({
  id: Type.String(),
  text: Type.String(),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }))),
  multi: Type.Optional(Type.Boolean()),
});
export const UserInputActivity = Type.Object({
  ...ActivityBase,
  kind: Type.Literal("user-input"),
  requestId: Type.String(),
  questions: Type.Array(UserInputQuestion),
  status: Type.Union([Type.Literal("pending"), Type.Literal("resolved")]),
  answers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
/** a harness-native sub-agent / collab child */
export const ChildActivity = Type.Object({
  ...ActivityBase,
  kind: Type.Literal("child"),
  childKey: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]),
  childThreadId: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});
export const InfoActivity = Type.Object({
  ...ActivityBase,
  kind: Type.Union([Type.Literal("info"), Type.Literal("error")]),
  text: Type.String(),
  /** raw harness payload for events Tide does not model (rendered generically, expandable) */
  payload: Type.Optional(Type.Unknown()),
});
export const Activity = Type.Union([ToolActivity, ApprovalActivity, UserInputActivity, ChildActivity, InfoActivity]);
export type Activity = Static<typeof Activity>;
export type ActivityOf<K extends Activity["kind"]> = Extract<Activity, { kind: K }>;

/** Output of a plan-mode turn. Never auto-implemented. */
export const ProposedPlan = Type.Object({
  id: Type.String(),
  threadId: Type.String(),
  turnId: Type.String(),
  markdown: Type.String(),
  status: Type.Union([Type.Literal("proposed"), Type.Literal("implemented"), Type.Literal("dismissed")]),
  implementationThreadId: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type ProposedPlan = Static<typeof ProposedPlan>;

/** One entry of a thread's chronological stream. */
export const TimelineEntry = Type.Object({
  kind: Type.Union([Type.Literal("message"), Type.Literal("activity"), Type.Literal("plan")]),
  id: Type.String(),
});
export type TimelineEntry = Static<typeof TimelineEntry>;

/** Whole read model. Small enough to hold in memory on server and client. */
export const ReadModel = Type.Object({
  /** seq of the last applied event; clients resume subscriptions from here */
  seq: Type.Number(),
  projects: Type.Record(Type.String(), Project),
  threads: Type.Record(Type.String(), Thread),
  turns: Type.Record(Type.String(), Turn),
  messages: Type.Record(Type.String(), Message),
  activities: Type.Record(Type.String(), Activity),
  plans: Type.Record(Type.String(), ProposedPlan),
  expertsSessions: Type.Record(Type.String(), ExpertsSession),
  expertsFindings: Type.Record(Type.String(), ExpertsFinding),
  expertsMessages: Type.Record(Type.String(), ExpertsMessage),
  /** threadId -> ordered messageIds (kept for simple consumers) */
  threadMessages: Type.Record(Type.String(), Type.Array(Type.String())),
  /** threadId -> ordered stream of messages, activities and plans */
  threadTimeline: Type.Record(Type.String(), Type.Array(TimelineEntry)),
});
export type ReadModel = Static<typeof ReadModel>;

export function emptyReadModel(): ReadModel {
  return {
    seq: 0, projects: {}, threads: {}, turns: {}, messages: {}, activities: {}, plans: {},
    expertsSessions: {}, expertsFindings: {}, expertsMessages: {}, threadMessages: {}, threadTimeline: {},
  };
}
