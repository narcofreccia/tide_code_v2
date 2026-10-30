import type { NormalizedEvent } from "@tide/contracts";

/**
 * One configured ACP agent. The server resolves registry agents (`acpAgentId`) to a launch
 * command before creating the instance; this driver only launches what it is given.
 */
export interface AcpConfig {
  /** executable to launch (`opencode`, `npx`, an absolute path…) */
  command: string;
  /** e.g. `["acp"]` or `["-y", "@google/gemini-cli@0.66.0", "--acp"]` */
  args?: string[];
  /** extra process environment (API keys, GEMINI_MODEL…) */
  env?: Record<string, string>;
  /** account home: exported as `HOME` for the agent process when set */
  home?: string;
  /** display name used in hints ("Gemini CLI"); defaults to the instance label or the command */
  label?: string;
  /** model id used when a thread does not pin one */
  defaultModel?: string;
}

/** The slice of a Readable the line reader uses. */
export interface LineSource {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

/** The slice of `child_process.ChildProcess` this driver uses. Kept structural for tests. */
export interface ChildLike {
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  stdout: LineSource | null;
  stderr: LineSource | null;
  kill(signal?: NodeJS.Signals): unknown;
  once(event: "exit" | "error", listener: (...args: never[]) => void): unknown;
}

export type SpawnLike = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;

export interface TimerLike {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Injected seams. Tests replace them; production wires node's `spawn` (process-group kill). */
export interface AcpDeps {
  spawn: SpawnLike;
  timers?: TimerLike;
  /** ms to wait for `initialize` (first `npx` start downloads the agent) */
  initializeTimeoutMs?: number;
}

export type Emit = (event: NormalizedEvent) => void;

// ---- ACP v1 wire shapes (schema/v1/schema.json of @agentclientprotocol/sdk 2.1.0). Loose on
// purpose: unknown fields and variants pass through. ----

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
  type?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: Record<string, unknown> & { additionalDirectories?: unknown };
  };
  agentInfo?: { name?: string; title?: string; version?: string } | null;
  authMethods?: AcpAuthMethod[];
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpModes {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface AcpSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: string;
  currentValue?: unknown;
  /** flat list, or groups `{group, name, options}` */
  options?: (AcpSelectOption | { group: string; name: string; options: AcpSelectOption[] })[];
}

/** Pre-configOptions model selector (unstable, still sent by OpenCode 1.1.x and Zed agents). */
export interface AcpLegacyModels {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: AcpModes | null;
  configOptions?: AcpConfigOption[] | null;
  models?: AcpLegacyModels | null;
}

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpToolCall {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolStatus | null;
  content?: AcpToolContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type AcpToolContent =
  | { type: "content"; content: AcpContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface AcpContentBlock {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** `PromptResponse.usage` (unstable in ACP v1; OpenCode 2.x sends it per turn). */
export interface AcpPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** JSON-RPC error codes ACP uses. */
export const ACP_ERROR = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** `auth_required` (schema ErrorCode) */
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;
