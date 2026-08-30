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
export const Project = Type.Object({
  id: Type.String(),
  title: Type.String(),
  rootPath: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  archivedAt: Type.Optional(Type.Number()),
});
export type Project = Static<typeof Project>;

export const Thread = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  parentThreadId: Type.Optional(Type.String()),
  title: Type.String(),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: RuntimeMode,
  interaction: InteractionMode,
  worktreePath: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  status: ThreadStatus,
  attention: Type.Optional(AttentionKind),
  latestTurnId: Type.Optional(Type.String()),
  /** the harness's own session id (claude session_id, codex threadId, …) for resume / open-in-terminal */
  nativeSessionId: Type.Optional(Type.String()),
  /** live plan/todo progress reported by the harness during a turn */
  planProgress: Type.Optional(Type.Object({ steps: Type.Array(Type.Object({ text: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) })), updatedAt: Type.Number() })),
  contextUsage: Type.Optional(Type.Object({ used: Type.Number(), window: Type.Number() })),
  totalCostUsd: Type.Optional(Type.Number()),
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
  createdAt: Type.Number(),
  /** true while the assistant is still streaming into this message */
  streaming: Type.Optional(Type.Boolean()),
});
export type Message = Static<typeof Message>;

export const TurnUsage = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  cacheWriteTokens: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
});
export type TurnUsage = Static<typeof TurnUsage>;

export const Turn = Type.Object({
  id: Type.String(),
  threadId: Type.String(),
  status: TurnStatus,
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
  /** threadId -> ordered messageIds (kept for simple consumers) */
  threadMessages: Type.Record(Type.String(), Type.Array(Type.String())),
  /** threadId -> ordered stream of messages, activities and plans */
  threadTimeline: Type.Record(Type.String(), Type.Array(TimelineEntry)),
});
export type ReadModel = Static<typeof ReadModel>;

export function emptyReadModel(): ReadModel {
  return { seq: 0, projects: {}, threads: {}, turns: {}, messages: {}, activities: {}, plans: {}, threadMessages: {}, threadTimeline: {} };
}
