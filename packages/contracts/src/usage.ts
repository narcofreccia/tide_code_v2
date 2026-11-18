import { Type, type Static } from "typebox";

// Usage, subscription limits and quotas. Kept apart from domain.ts (which re-exports it) so the
// read-model entities stay under the file-size rule.

/**
 * R20: which of the harness's windows a report is about. `session` is the short one (Claude
 * `five_hour`, Codex primary), `weekly` the long one. A report about anything else (an overage
 * window, a per-model window) carries no `window`.
 */
export const LimitWindow = Type.Union([Type.Literal("session"), Type.Literal("weekly")]);
export type LimitWindow = Static<typeof LimitWindow>;

/** Subscription / API rate-limit status as the harness reports it (Claude rate_limit_event, Codex account/rateLimits). */
export const RateLimit = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("warning"), Type.Literal("limited")]),
  /** 0..100, share of the window still available when the harness says */
  remainingPct: Type.Optional(Type.Number()),
  resetsAt: Type.Optional(Type.Number()),
  overage: Type.Optional(Type.Boolean()),
  /** harness wording, shown verbatim */
  note: Type.Optional(Type.String()),
  /** R20: set when the harness names the window; such a report also lands in `ReadModel.limits` */
  window: Type.Optional(LimitWindow),
  /** R20: the window's length when the harness says (300 = 5 h, 10080 = 7 d) */
  windowMins: Type.Optional(Type.Number()),
  at: Type.Number(),
});
export type RateLimit = Static<typeof RateLimit>;

export const Limited = Type.Object({
  resetsAt: Type.Optional(Type.Number()),
  /** `reset`: resume the thread automatically when the window reopens; `manual`: wait for the user */
  resume: Type.Union([Type.Literal("manual"), Type.Literal("reset")]),
  note: Type.Optional(Type.String()),
  /** R20: the window that refused the turn, when the harness named it */
  window: Type.Optional(LimitWindow),
  at: Type.Number(),
});
export type Limited = Static<typeof Limited>;

/** Always a delta for the report it rides on; the projector sums reports into Turn.usage. */
export const TurnUsage = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  cacheWriteTokens: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
});
export type TurnUsage = Static<typeof TurnUsage>;

// ---- R20: usage quotas. An optional cap on a project or a thread. ----

export const QuotaScope = Type.Union([Type.Literal("project"), Type.Literal("thread")]);
export type QuotaScope = Static<typeof QuotaScope>;

/**
 * At least one of the two caps is set (the decider refuses a quota with neither).
 * `sharePct` counts against each harness instance's weekly window on its own; `usdPerWeek`
 * counts every instance together.
 */
export const Quota = Type.Object({
  /** share of the instance's weekly window this scope may use; only where the harness reports that window */
  sharePct: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
  /** USD at list prices over a rolling 7 days (reported cost, else Tide's estimate) */
  usdPerWeek: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  /** `hold`: new and queued turns wait once the cap is reached; `warn`: nothing is blocked */
  onExceed: Type.Union([Type.Literal("warn"), Type.Literal("hold")]),
});
export type Quota = Static<typeof Quota>;

/** What the quota worker last measured for a scope. Written only on a status change or a coarse step. */
export const QuotaState = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("warning"), Type.Literal("exceeded")]),
  /** how much of the quota is used, 100 = at the cap (the worse of the two caps) */
  usedPct: Type.Number(),
  /** which cap `usedPct` is about */
  basis: Type.Union([Type.Literal("share"), Type.Literal("usd")]),
  /** instance ids past the share cap; `*` = the USD cap, which holds every instance */
  over: Type.Array(Type.String()),
  /** when the measured window ends; a held scope is free again once it has passed */
  windowEndsAt: Type.Optional(Type.Number()),
  /** the user lifted the hold until then (`quota.lift`) */
  liftedUntil: Type.Optional(Type.Number()),
  /** spend Tide cannot see (other devices) or an estimated price is part of the figure */
  approx: Type.Optional(Type.Boolean()),
  at: Type.Number(),
});
export type QuotaState = Static<typeof QuotaState>;
