import { Type, type Static } from "typebox";
import { MergeStrategy, ProviderInstanceConfig, ProviderKind, RuntimeMode, Team } from "./domain.ts";

// User settings (server-side, per environment). Kept apart from rpc.ts, which re-exports it.

export const DecisionSites = Type.Object({ handoff: Type.Boolean(), experts: Type.Boolean(), delegates: Type.Boolean(), approvals: Type.Boolean(), stuck: Type.Boolean() });
export type DecisionSites = Static<typeof DecisionSites>;
export const DecisionsSettings = Type.Object({
  enabled: Type.Boolean(),
  hasKey: Type.Boolean(),
  model: Type.String(),
  endpoint: Type.String(),
  usdPerMillionInput: Type.Number(),
  contextTokens: Type.Number(),
  /** harness model asked when Jev is unsure; absent = Jev only */
  fallback: Type.Optional(Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()) })),
  /** `high`: below it the fallback is asked; `low`: below it nothing is shown or acted on */
  grayZone: Type.Object({ low: Type.Number(), high: Type.Number() }),
  sites: DecisionSites,
  /** opt-in: when the experts judge says converged (≥ high, Jev), advance one phase automatically */
  expertsAutoAdvance: Type.Boolean(),
});
export type DecisionsSettings = Static<typeof DecisionsSettings>;

export const InboxSettings = Type.Object({
  /** settle an idle, unpinned thread with nothing pending after this many days; 0 = never */
  autoSettleAfterDays: Type.Number(),
  /** settle when the thread's PR is merged or its branch merged back */
  autoSettleOnMerge: Type.Boolean(),
  /** archive (and remove the worktree) instead of only settling when auto-settle triggers on merge or inactivity */
  archiveOnAutoSettle: Type.Optional(Type.Boolean()),
  /** rail: hide running threads in a collapsed "Working" group unless pinned */
  workingSection: Type.Boolean(),
  /** R16: snooze menu entries — durations (`2h`, `1d`, `45m`) or a time on a day (`tomorrow 09:00`, `fri 18:00`); ≤ 8 */
  snoozeOptions: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 32 }), { maxItems: 8 })),
});
export type InboxSettings = Static<typeof InboxSettings>;

/** R12: merge-back defaults for the solo flow — `thread.merge` without an explicit strategy uses these. */
export const GitSettings = Type.Object({
  mergeStrategy: MergeStrategy,
  /** remove the tide/<slug> branch and worktree after a successful merge back */
  deleteBranchOnMerge: Type.Boolean(),
  /** ask before merging back from the rail (`m`, hover action, bulk); the thread header button always confirms */
  confirmMergeBack: Type.Boolean(),
  /** R17: push `tide/*` thread branches to origin — never, after every checkpoint, or once when a merge back is requested */
  pushThreadBranches: Type.Union([Type.Literal("never"), Type.Literal("on-checkpoint"), Type.Literal("on-merge-request")]),
  /** R17: before a merge back fetch + fast-forward the base from origin; an unreachable origin merges locally with a warning (R18) */
  syncBaseWithRemote: Type.Boolean(),
  /** R18: after a local merge back push the base to origin. Off by default: publishing the base is the user's call */
  pushBaseAfterMerge: Type.Boolean(),
  /** R17: merge-back squash subjects and publish commit / PR text come from `textModel` (fallback `tide: <title>`) */
  generateMessages: Type.Boolean(),
});
export type GitSettings = Static<typeof GitSettings>;

export const CodexMultiAgentModeSchema = Type.Union([Type.Literal("proactive"), Type.Literal("explicitRequestOnly")]);

/** User settings that must be visible to every client and to server-created threads (delegates, experts, plan.implement). */
export const UserSettings = Type.Object({
  providerDefaults: Type.Record(
    Type.String(),
    Type.Object({
      model: Type.Optional(Type.String()),
      mode: Type.Optional(RuntimeMode),
      /** Codex only: proactive lets Codex fan out sub-agents without being explicitly told to. */
      multiAgentMode: Type.Optional(CodexMultiAgentModeSchema),
    }),
  ),
  worktreeByDefault: Type.Boolean(),
  /**
   * R6: the decision layer. TypeSafe Jev (System One) is the calibrated first filter; when its
   * confidence is below `grayZone.high` the user-selected `fallback` harness model is asked
   * (one-shot, tools off). Off by default. `model/endpoint/usdPerMillionInput/contextTokens`
   * are informational, from the server's client constants.
   */
  decisions: DecisionsSettings,
  /** R4: after a restart, interrupted threads get a "Continue where you left off" turn (max 3 in a row); off by default */
  continueAfterRestart: Type.Boolean(),
  /** R5: what a running thread does with a follow-up by default (⌘↵ always sends this; ⌥↵ the other) */
  followUpMode: Type.Union([Type.Literal("steer"), Type.Literal("queue")]),
  /** R5: when a harness reports its usage limit: wait for the user, or resume at reset */
  limitPolicy: Type.Union([Type.Literal("manual"), Type.Literal("reset")]),
  /** R5: saved teams (lead + stages across harnesses) */
  teams: Type.Array(Team),
  /** R7: the inbox rules (T3-style "every open thread should get closed") */
  inbox: InboxSettings,
  /** R12: merge-back defaults */
  git: GitSettings,
  /** R9: this machine as seen by other clients. R17: `lanBind` = the desktop sidecar binds 0.0.0.0 (restart); `projectsDir` = where `project.ensure` clones */
  environment: Type.Object({ name: Type.String(), sshHost: Type.Optional(Type.String()), lanBind: Type.Optional(Type.Boolean()), projectsDir: Type.Optional(Type.String()) }),
  /** R11: user keybindings by shortcut id (display string like "⌘⇧E" normalised to `mod+shift+e`); absent = default. Synced across this server's clients. */
  keybindings: Type.Record(Type.String(), Type.String()),
  /** R10: glass-box toggles */
  glassBox: Type.Object({
    /** status bar shows the tightest harness limit (5 h / weekly) at all times */
    limitsInStatusBar: Type.Boolean(),
    /** the usage page may read the harnesses' own local logs for spend made outside Tide */
    readHarnessLogs: Type.Boolean(),
  }),
  /** R9: optional self-hosted relay this server dials out to (apps/relay); the key is never returned, `hasKey` says whether one is stored */
  relay: Type.Optional(Type.Object({ url: Type.String(), hasKey: Type.Boolean() })),
  /**
   * R8: configured harness instances (accounts, ACP agents). The four bundled defaults are implicit
   * and never stored; this list holds only what the user added.
   */
  providerInstances: Type.Array(ProviderInstanceConfig),
  /**
   * R7: harness model used for short text generation on the user's own subscription (thread titles,
   * later commit messages / PR bodies) via the one-shot `complete()`. Absent = the first harness with `oneShot`.
   */
  textModel: Type.Optional(Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()) })),
  /** R16: free text appended to the auto-title prompt ("start with the ticket id", "≤ 5 words", …); a project's own instructions win */
  titleInstructions: Type.Optional(Type.String({ maxLength: 500 })),
});
export type UserSettings = Static<typeof UserSettings>;
export const UserSettingsPatch = Type.Object({
  providerDefaults: Type.Optional(UserSettings.properties.providerDefaults),
  worktreeByDefault: Type.Optional(Type.Boolean()),
  decisions: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    /** null clears the fallback */
    fallback: Type.Optional(Type.Union([Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()) }), Type.Null()])),
    grayZone: Type.Optional(Type.Object({ low: Type.Number(), high: Type.Number() })),
    sites: Type.Optional(Type.Partial(DecisionSites)),
    expertsAutoAdvance: Type.Optional(Type.Boolean()),
  })),
  continueAfterRestart: Type.Optional(Type.Boolean()),
  followUpMode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("queue")])),
  limitPolicy: Type.Optional(Type.Union([Type.Literal("manual"), Type.Literal("reset")])),
  /** replaces the whole list */
  teams: Type.Optional(Type.Array(Team)),
  inbox: Type.Optional(Type.Partial(InboxSettings)),
  git: Type.Optional(Type.Partial(GitSettings)),
  /** replaces the whole list; ids must be unique and must not shadow a bundled kind */
  providerInstances: Type.Optional(Type.Array(ProviderInstanceConfig)),
  environment: Type.Optional(Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), sshHost: Type.Optional(Type.Union([Type.String(), Type.Null()])), lanBind: Type.Optional(Type.Boolean()), /** null clears it */ projectsDir: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])) })),
  glassBox: Type.Optional(Type.Object({ limitsInStatusBar: Type.Optional(Type.Boolean()), readHarnessLogs: Type.Optional(Type.Boolean()) })),
  /** replaces the whole map; an empty string value resets that id to its default */
  keybindings: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** null disconnects and forgets the relay */
  relay: Type.Optional(Type.Union([Type.Object({ url: Type.String(), key: Type.Optional(Type.String()) }), Type.Null()])),
  /** null clears it (back to "first harness with oneShot") */
  textModel: Type.Optional(Type.Union([Type.Object({ provider: ProviderKind, model: Type.Optional(Type.String()) }), Type.Null()])),
  /** null clears it */
  titleInstructions: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
});
export type UserSettingsPatch = Static<typeof UserSettingsPatch>;
