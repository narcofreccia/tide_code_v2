import type { Activity, ApprovalDecision, InteractionMode, ProviderKind, RateLimit, RuntimeMode, SlashCommandInfo, TurnUsage } from "./domain.ts";

// Provider driver SPI (TypeScript-only; not on the wire). One implementation per
// harness in packages/driver-*. Drivers translate native protocols into
// NormalizedEvent and hold no orchestration logic.

export interface ModelInfo {
  id: string;
  label: string;
  /** e.g. "opus" | "sonnet"; free-form, from the harness */
  family?: string;
  default?: boolean;
  /** R8: reasoning-effort levels this model accepts, from the harness (Codex supportedReasoningEfforts, Claude effort levels, OpenCode variants, Pi thinking levels) */
  efforts?: { id: string; label: string; default?: boolean }[];
}

export interface DriverCaps {
  planMode: boolean;
  subagents: boolean;
  mcp: boolean;
  images: boolean;
  resume: boolean;
  contextUsage: boolean;
  /** the harness exposes a command to reopen the session in a terminal */
  openInTerminal: boolean;
  // ---- R4 (optional: undefined = unsupported, the server falls back to queue / handoff / conversation-only) ----
  /** `ProviderSession.steer` lands a message inside the running turn */
  steer?: boolean;
  /** `openSession({ forkFrom })` opens a new native session that continues another one's history */
  fork?: boolean;
  /** `ProviderSession.rollback` drops the last N turns from the harness's own conversation */
  rollback?: boolean;
  /** R6: `ProviderInstance.complete` answers a tool-less one-shot prompt (the judge fallback) */
  oneShot?: boolean;
  /** R8: models carry `efforts` and `OpenSessionOptions.effort` / `SessionSettings.effort` are honoured */
  effort?: boolean;
  /** R8: the harness lists slash commands / skills (`ProviderInstance.listCommands` or a `commands` event) */
  commands?: boolean;
  /**
   * R14: the harness can run a turn nobody asked for — Claude Code resumes when a background
   * sub-agent reports — and the session surfaces it through `ProviderSession.onHarnessTurn`.
   */
  harnessTurns?: boolean;
}

/**
 * R6: a one-shot, tools-off completion on the user's own harness subscription. Not a user thread:
 * no project settings, no MCP, no skills (documented exception to the "never cripple" rule — the
 * harness is used as a model endpoint the user already pays for).
 */
export interface CompletionRequest {
  system: string;
  prompt: string;
  model?: string;
  /** when given, drivers that support an output schema constrain the answer to one of these */
  labels?: string[];
  maxOutputTokens?: number;
  timeoutMs: number;
  /** structural so contracts need no DOM/node lib; a real AbortSignal fits */
  signal?: { readonly aborted: boolean; addEventListener(type: "abort", listener: () => void): void };
  /** scratch directory the driver may use; never a user worktree */
  cwd: string;
}
export interface CompletionResult {
  text: string;
  /** set when the harness constrained the answer to `labels` */
  label?: string;
  model?: string;
  /** only when the harness reports it; never estimated */
  usage?: TurnUsage;
  elapsedMs: number;
}

/** Instance id and label are the registry's (from `ProviderInstanceConfig`), not the driver's. */
export interface ProviderStatus {
  kind: ProviderKind;
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  /** shown to the user when not usable (e.g. "run `claude auth login`") */
  hint?: string;
  /** exact shell command that logs the user in (UI offers to run it in a terminal) */
  loginCommand?: string;
  models: ModelInfo[];
  caps: DriverCaps;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** W1: a linked repository the session may reach, resolved from the project's links. */
export interface LinkedDir {
  path: string;
  label: string;
  note?: string;
  access: "read" | "write";
}

export interface OpenSessionOptions {
  threadId: string;
  cwd: string;
  /** harness-native session id to resume, if any */
  resume?: string;
  /**
   * R4: open a *new* native session that starts from this session's history (thread fork).
   * Mutually exclusive with `resume`. The server then calls `rollback(n)` when the fork point is
   * not the source's latest turn. Only honoured when `caps.fork`.
   */
  forkFrom?: string;
  model?: string;
  /** R8: effort id from `ModelInfo.efforts`; undefined = harness default */
  effort?: string;
  mode: RuntimeMode;
  interaction: InteractionMode;
  mcpServers: McpServerSpec[];
  systemPromptAppend?: string;
  /** W1: secondary repos this thread may reach (never worktrees — always the real path) */
  linkedDirs?: LinkedDir[];
  env?: Record<string, string>;
}

export interface TurnInput {
  text: string;
  /** base64 images with media type; drivers that can't accept them drop with an info activity */
  images?: { mediaType: string; data: string }[];
}

/** The thread settings a live session must honour from the next turn on. */
export interface SessionSettings {
  model?: string;
  effort?: string;
  mode: RuntimeMode;
  interaction: InteractionMode;
}
/** `applied` = the harness switched in place; `reopen` = the directory must close and reopen (with resume). */
export type ReconfigureResult = "applied" | "reopen";

/** Activity as produced by a driver: the reactor fills id/threadId/turnId/timestamps. */
export type DriverActivity =
  | (Omit<Extract<Activity, { kind: "tool" }>, "id" | "threadId" | "turnId" | "createdAt" | "updatedAt"> & { id?: string })
  | (Omit<Extract<Activity, { kind: "approval" }>, "id" | "threadId" | "turnId" | "createdAt" | "updatedAt"> & { id?: string })
  | (Omit<Extract<Activity, { kind: "user-input" }>, "id" | "threadId" | "turnId" | "createdAt" | "updatedAt"> & { id?: string })
  | (Omit<Extract<Activity, { kind: "child" }>, "id" | "threadId" | "turnId" | "createdAt" | "updatedAt"> & { id?: string })
  | (Omit<Extract<Activity, { kind: "info" | "error" }>, "id" | "threadId" | "turnId" | "createdAt" | "updatedAt"> & { id?: string });

export type NormalizedEvent =
  | { type: "session"; nativeSessionId: string; model?: string }
  | { type: "assistant.delta"; messageKey: string; delta: string }
  /** extended-thinking / reasoning text, attached to the same message as the following text */
  | { type: "assistant.reasoning"; messageKey: string; delta: string }
  | { type: "activity"; activity: DriverActivity }
  | { type: "plan.proposed"; markdown: string }
  | { type: "plan.progress"; steps: { text: string; status: "pending" | "in_progress" | "completed" }[] }
  /**
   * `usage` is always a DELTA for the turn (the projector sums reports). A harness that reports
   * cumulative figures (Claude's per-query() totals) must subtract what it already reported.
   * Several reports per turn are fine (Codex emits one per model request).
   */
  | { type: "usage"; usage?: TurnUsage; contextUsage?: { used: number; window: number }; rateLimit?: RateLimit }
  /** R8: the session's slash commands / skills changed (ACP available_commands_update, Codex skills changed) — full list */
  | { type: "commands"; commands: SlashCommandInfo[] }
  | { type: "settled"; status: "completed" | "interrupted" | "error"; error?: string };

export interface ProviderSession {
  readonly nativeSessionId: string | undefined;
  /** Runs one turn; the iterable ends after a `settled` event. */
  send(input: TurnInput): AsyncIterable<NormalizedEvent>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  /**
   * Called between turns when the thread's model/mode/interaction changed. Optional: a driver
   * that omits it (or answers `reopen`) gets closed and reopened with `resume` by the server.
   */
  reconfigure?(settings: SessionSettings): Promise<ReconfigureResult>;
  /**
   * R4: deliver a user message into the turn that `send` is currently running, without
   * interrupting tools (Claude SDK streaming input, Codex `turn/steer`, Pi `steer`, OpenCode
   * `prompt` while busy). Rejects when no turn is running. Only called when `caps.steer`.
   */
  steer?(input: TurnInput): Promise<void>;
  /**
   * R4: forget the last `turns` turns of the harness's own conversation (Codex `thread/revert`,
   * Pi session tree, OpenCode `session.revert`). Called between turns only. Only when `caps.rollback`.
   */
  rollback?(turns: number): Promise<void>;
  /**
   * R14: subscribe to turns the harness starts by itself between `send`s (Claude Code's
   * background sub-agents finishing re-invoke the model, and the CLI then runs tools, streams
   * text and may ask the user — with nobody reading). The driver buffers every event of such a
   * turn until the listener's iterable is consumed; the iterable ends after its `settled` event.
   * `reason` is one line for the notice ("sub-agent 'Audit feature gaps' reported"). A `send`
   * that arrives while a harness turn runs waits for it to settle instead of failing `busy`.
   * Only when `caps.harnessTurns`.
   */
  onHarnessTurn?(listener: (turn: { reason: string; events: AsyncIterable<NormalizedEvent> }) => void): void;
  /**
   * R14: true while the harness still has work running outside a turn (backgrounded sub-agents
   * that have not reported). The server keeps such a session off the idle reaper.
   */
  hasBackgroundWork?(): boolean;
}

export interface ProviderInstance {
  readonly kind: ProviderKind;
  status(): Promise<ProviderStatus>;
  /** R8: slash commands + skills available in `cwd` (project-level ones included); only when `caps.commands` */
  listCommands?(options: { cwd: string }): Promise<SlashCommandInfo[]>;
  openSession(options: OpenSessionOptions): Promise<ProviderSession>;
  /** shell command that reopens a session in a terminal (escape hatch), if supported */
  terminalCommand(nativeSessionId: string, cwd: string): string | undefined;
  /** R6: one-shot classifier call; only when `caps.oneShot` */
  complete?(request: CompletionRequest): Promise<CompletionResult>;
  dispose(): Promise<void>;
}

export interface DriverEnv {
  /** where drivers may write logs/caches */
  dataDir: string;
  log: (msg: string, data?: unknown) => void;
  /** R8: the instance this driver is created for (id = kind for the default instance) */
  instance?: { id: string; label: string; home?: string; env?: Record<string, string> };
}

export interface ProviderDriver<Config = Record<string, unknown>> {
  readonly kind: ProviderKind;
  defaultConfig(): Config;
  create(config: Config, env: DriverEnv): Promise<ProviderInstance>;
}
