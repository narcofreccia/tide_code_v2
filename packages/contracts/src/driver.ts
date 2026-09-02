import type { Activity, ApprovalDecision, InteractionMode, ProviderKind, RuntimeMode, TurnUsage } from "./domain.ts";

// Provider driver SPI (TypeScript-only; not on the wire). One implementation per
// harness in packages/driver-*. Drivers translate native protocols into
// NormalizedEvent and hold no orchestration logic.

export interface ModelInfo {
  id: string;
  label: string;
  /** e.g. "opus" | "sonnet"; free-form, from the harness */
  family?: string;
  default?: boolean;
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
}

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
  model?: string;
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
  | { type: "usage"; usage?: TurnUsage; contextUsage?: { used: number; window: number } }
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
}

export interface ProviderInstance {
  readonly kind: ProviderKind;
  status(): Promise<ProviderStatus>;
  openSession(options: OpenSessionOptions): Promise<ProviderSession>;
  /** shell command that reopens a session in a terminal (escape hatch), if supported */
  terminalCommand(nativeSessionId: string, cwd: string): string | undefined;
  dispose(): Promise<void>;
}

export interface DriverEnv {
  /** where drivers may write logs/caches */
  dataDir: string;
  log: (msg: string, data?: unknown) => void;
}

export interface ProviderDriver<Config = Record<string, unknown>> {
  readonly kind: ProviderKind;
  defaultConfig(): Config;
  create(config: Config, env: DriverEnv): Promise<ProviderInstance>;
}
