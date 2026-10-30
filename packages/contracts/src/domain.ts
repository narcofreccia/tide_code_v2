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

/**
 * R6: a judgement by the decision layer. `jev` is TypeSafe's calibrated classifier (first filter),
 * `fallback` the user-selected harness model asked only when Jev is unsure, `none` when no judge
 * ran (feature off / no key): callers then behave exactly as without the layer. Verdicts annotate
 * or suggest; the only automatic actions are the ones the user opts into.
 */
export const JudgeSite = Type.Union([Type.Literal("handoff"), Type.Literal("experts"), Type.Literal("delegates"), Type.Literal("approvals"), Type.Literal("stuck")]);
export type JudgeSite = Static<typeof JudgeSite>;
export const JudgeSource = Type.Union([Type.Literal("jev"), Type.Literal("fallback"), Type.Literal("none")]);
export type JudgeSource = Static<typeof JudgeSource>;
export const Verdict = Type.Object({
  site: JudgeSite,
  label: Type.Optional(Type.String()),
  /** 0..1 (yes-no probability or normalised score level) */
  score: Type.Optional(Type.Number()),
  /** 0..1; Jev's calibrated confidence, 1/0 for a fallback label match, 0 for `none` */
  confidence: Type.Number(),
  source: JudgeSource,
  at: Type.Number(),
});
export type Verdict = Static<typeof Verdict>;
/** how a handoff selection was refined by the judge */
export const HandoffJudge = Type.Object({ kept: Type.Number(), dropped: Type.Number(), source: JudgeSource, confidence: Type.Number(), at: Type.Number() });
export type HandoffJudge = Static<typeof HandoffJudge>;

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
  /** R6: "the experts have converged" verdict (label "true"/"false") */
  judge: Type.Optional(Verdict),
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


/**
 * R5: a Team is an ordered set of roles on chosen harnesses. Stage 1 is the lead thread; it
 * delegates the later stages through `tide_delegate` (completion: wait), each on its harness,
 * in its own worktree or in an earlier stage's (`inherit`), so a reviewer reads the implementer's
 * branch. Teams live in settings; a run copies the team onto the lead thread.
 */
export const TeamStage = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 32 }),
  /** free text shown in the rail and used in the delegate preamble (planner, implementer, reviewer, tester…) */
  role: Type.String({ minLength: 1, maxLength: 40 }),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  interaction: Type.Optional(InteractionMode),
  /** `own`: a fresh worktree; `inherit`: the worktree of the stage named in `inheritFrom` (default: the previous stage) */
  worktree: Type.Union([Type.Literal("own"), Type.Literal("inherit")]),
  inheritFrom: Type.Optional(Type.String()),
  /** extra instructions for this stage, appended to the generated brief */
  instructions: Type.Optional(Type.String()),
});
export type TeamStage = Static<typeof TeamStage>;
export const Team = Type.Object({
  id: Type.String(),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  stages: Type.Array(TeamStage, { minItems: 1, maxItems: 6 }),
});
export type Team = Static<typeof Team>;

export const PullRequest = Type.Object({
  url: Type.String(),
  number: Type.Number(),
  state: Type.Union([Type.Literal("open"), Type.Literal("merged"), Type.Literal("closed")]),
  updatedAt: Type.Number(),
  /** CI rollup as the host reports it (R4: PR watch) */
  checks: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("success"), Type.Literal("failure")])),
  mergeable: Type.Optional(Type.Boolean()),
  /** review + issue comments seen so far; a rise wakes a watched thread */
  comments: Type.Optional(Type.Number()),
});
export type PullRequest = Static<typeof PullRequest>;

/** The harness refused to continue because the subscription window is exhausted (R4). */
/** R7: why a thread left the inbox. `user` = the checkbox; the rest are the settlement reactor's. */
export const SettleReason = Type.Union([Type.Literal("user"), Type.Literal("pr-merged"), Type.Literal("merged-back"), Type.Literal("inactive")]);
export type SettleReason = Static<typeof SettleReason>;

export const Limited = Type.Object({
  resetsAt: Type.Optional(Type.Number()),
  /** `reset`: resume the thread automatically when the window reopens; `manual`: wait for the user */
  resume: Type.Union([Type.Literal("manual"), Type.Literal("reset")]),
  note: Type.Optional(Type.String()),
  at: Type.Number(),
});
export type Limited = Static<typeof Limited>;

export const HandoffStrategy = Type.Union([Type.Literal("delta"), Type.Literal("full")]);
export type HandoffStrategy = Static<typeof HandoffStrategy>;
/**
 * Portable context carried to a harness that has not seen (all of) the thread: a budgeted,
 * verbatim selection of the thread's history, never a model-written summary. Recorded as an
 * event before the turn that consumes it, so the text the agent saw is auditable.
 */
export const Handoff = Type.Object({
  id: Type.String(),
  threadId: Type.String(),
  /** where the history came from: the thread itself (provider switch) or the fork source */
  sourceThreadId: Type.String(),
  fromProvider: Type.Optional(ProviderKind),
  toProvider: ProviderKind,
  strategy: HandoffStrategy,
  /** turn ids whose history the text covers, oldest first; `omitted` are the ones that did not fit */
  coveredTurnIds: Type.Array(Type.String()),
  omittedTurnIds: Type.Array(Type.String()),
  text: Type.String(),
  createdAt: Type.Number(),
  /** R6: set once `handoff.refined` replaced the recency selection with the judge's ranking */
  judge: Type.Optional(HandoffJudge),
});
export type Handoff = Static<typeof Handoff>;

/** Outcome of the last `thread.rollback`. */
export const RollbackState = Type.Object({
  status: Type.Union([Type.Literal("rolling"), Type.Literal("done"), Type.Literal("error")]),
  turnId: Type.String(),
  restoreFiles: Type.Boolean(),
  error: Type.Optional(Type.String()),
  at: Type.Number(),
});
export type RollbackState = Static<typeof RollbackState>;

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
  /** R4: free-text role the delegating agent gave this child (review, research, …) */
  delegateRole: Type.Optional(Type.String()),
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
  /** R6: latest verdict about this thread (delegate outcome, stuck) */
  judge: Type.Optional(Verdict),
  /** R6: per-thread opt-in: approvals the judge calls routine (Jev, confidence ≥ high) are accepted automatically */
  autoAllowRoutine: Type.Optional(Type.Boolean()),
  // ---- R4: orchestration parity ----
  /** this thread was forked from another thread at a settled turn */
  forkedFrom: Type.Optional(Type.Object({ threadId: Type.String(), turnId: Type.String() })),
  /** native session id per harness that ran this thread, so switching back resumes it with a delta handoff */
  providerSessions: Type.Optional(Type.Record(Type.String(), Type.Object({ nativeSessionId: Type.String(), lastTurnId: Type.Optional(Type.String()) }))),
  /** a handoff waiting for the next turn to carry it to the harness */
  pendingHandoffId: Type.Optional(Type.String()),
  rollback: Type.Optional(RollbackState),
  limited: Type.Optional(Limited),
  /** hidden from the Inbox / Now strip until then; cleared by activity that needs the user */
  snoozedUntil: Type.Optional(Type.Number()),
  /** R5: kept at the top of its project in the rail */
  pinned: Type.Optional(Type.Boolean()),
  /**
   * R7: settled = closed from the inbox without touching the worktree (archive does that).
   * Cleared by a new turn or by anything that needs the user, so a settled thread that
   * speaks up comes back on its own.
   */
  settledAt: Type.Optional(Type.Number()),
  settleReason: Type.Optional(SettleReason),
  /** R7: per-thread override of the inbox auto-settle rules; false = never settle this thread automatically */
  autoSettle: Type.Optional(Type.Boolean()),
  /** R5: this thread leads a team run; later stages are its delegates (matched by `delegateRole` = stage role) */
  team: Type.Optional(Type.Object({ name: Type.String(), stages: Type.Array(TeamStage) })),
  /** the server polls the linked PR and wakes the thread on CI failure, comments or conflicts */
  prWatch: Type.Optional(Type.Object({ since: Type.Number(), lastCheckedAt: Type.Optional(Type.Number()) })),
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
  /** user message delivered into the running turn (steer), not as a turn of its own */
  steer: Type.Optional(Type.Boolean()),
  /** server-authored wake-up (delegate finished, child asked a question, PR changed, restart) */
  notification: Type.Optional(Type.Object({
    source: Type.Union([Type.Literal("delegate"), Type.Literal("child-question"), Type.Literal("pr"), Type.Literal("restart"), Type.Literal("system"), Type.Literal("schedule")]),
    summary: Type.String(),
  })),
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
  /** the handoff this turn carried to the harness (provider switch / fork) */
  handoffId: Type.Optional(Type.String()),
  /** how the harness received it: inline text ahead of the prompt, or natively (resume / fork) with nothing injected */
  handoffDelivery: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("native")])),
  /** undone by a later `thread.rollback`; stays in the log, hidden from the harness's history */
  rolledBack: Type.Optional(Type.Boolean()),
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
  /** R6: routine | consequential, from the judge */
  judge: Type.Optional(Verdict),
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

/** When a scheduled task fires: a fixed interval, or given clock times on given weekdays (server time zone). */
export const Schedule = Type.Union([
  Type.Object({ kind: Type.Literal("interval"), everyMs: Type.Number({ minimum: 60_000 }) }),
  Type.Object({ kind: Type.Literal("fixed"), times: Type.Array(Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), { minItems: 1, maxItems: 24 }), weekdays: Type.Array(Type.Number({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }) }),
]);
export type Schedule = Static<typeof Schedule>;

/**
 * R4: an automation that sends a prompt on a schedule — into an existing thread (queued, never
 * interrupting) or as a new thread on the project. Missed fixed times are skipped, never fired late;
 * an overdue interval catches up once. Fires are idempotent (`scheduled:<id>:<epoch>` command ids).
 */
export const ScheduledTask = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  /** send into this thread; absent = a new thread per fire */
  threadId: Type.Optional(Type.String()),
  title: Type.String(),
  prompt: Type.String(),
  schedule: Schedule,
  /** for new threads: harness settings and worktree choice (default: project defaults / worktree on) */
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  useWorktree: Type.Optional(Type.Boolean()),
  enabled: Type.Boolean(),
  /** thread that created it through the agent tools, if any */
  createdByThreadId: Type.Optional(Type.String()),
  lastRunAt: Type.Optional(Type.Number()),
  lastRunThreadId: Type.Optional(Type.String()),
  nextRunAt: Type.Optional(Type.Number()),
  runs: Type.Number(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  archivedAt: Type.Optional(Type.Number()),
});
export type ScheduledTask = Static<typeof ScheduledTask>;

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
  handoffs: Type.Record(Type.String(), Handoff),
  scheduledTasks: Type.Record(Type.String(), ScheduledTask),
  /** threadId -> ordered messageIds (kept for simple consumers) */
  threadMessages: Type.Record(Type.String(), Type.Array(Type.String())),
  /** threadId -> ordered stream of messages, activities and plans */
  threadTimeline: Type.Record(Type.String(), Type.Array(TimelineEntry)),
});
export type ReadModel = Static<typeof ReadModel>;

export function emptyReadModel(): ReadModel {
  return {
    seq: 0, projects: {}, threads: {}, turns: {}, messages: {}, activities: {}, plans: {},
    expertsSessions: {}, expertsFindings: {}, expertsMessages: {}, handoffs: {}, scheduledTasks: {}, threadMessages: {}, threadTimeline: {},
  };
}
