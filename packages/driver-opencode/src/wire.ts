/**
 * The slice of opencode's HTTP/SSE vocabulary this driver reads, hand-written from the
 * server's own OpenAPI document (`GET /doc` on `opencode serve`, opencode 1.1.36) rather
 * than from `@opencode-ai/sdk`'s generated types: the installed server is ahead of the
 * published SDK and renamed `permission.updated` → `permission.asked`, added
 * `question.asked` and moved `Permission.title` into `patterns`/`metadata`. Both shapes
 * are modelled so the driver keeps working on either build.
 *
 * Everything here is structural and optional-tolerant — unknown events fall through to
 * `OpencodeEvent`'s open case and are ignored rather than dropped loudly (CLAUDE.md §1a
 * "pass through, don't translate, when unsure").
 */

export interface WireTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface WireMessageError {
  name: string;
  data?: { message?: string };
}

export interface WireUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  agent?: string;
  model?: { providerID: string; modelID: string };
  time: { created: number };
}

export interface WireAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  /** the agent that produced it; `mode` on older builds */
  agent?: string;
  mode?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: WireTokens;
  error?: WireMessageError;
  finish?: string;
  time: { created: number; completed?: number };
}

export type WireMessage = WireUserMessage | WireAssistantMessage;

export interface WireToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export interface WireTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  time?: { start?: number; end?: number };
}

/** `MessageV2.ReasoningPart` (opencode 1.1.36): same streaming shape as a text part. */
export interface WireReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export interface WireToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: WireToolState;
}

export interface WireSubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
}

export interface WireStepFinishPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason?: string;
  cost?: number;
  tokens?: WireTokens;
}

export interface WireOtherPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file" | "step-start" | "snapshot" | "patch" | "agent" | "retry" | "compaction" | (string & {});
}

export type WirePart = WireTextPart | WireReasoningPart | WireToolPart | WireSubtaskPart | WireStepFinishPart | WireOtherPart;

/** `permission.asked` (1.1.x) and `permission.updated` (sdk 1.18) unified. */
export interface WirePermission {
  id: string;
  sessionID: string;
  /** 1.1.x: the permission kind, e.g. "bash" | "edit" | "webfetch" | "plan_exit" */
  permission?: string;
  /** sdk 1.18 spelling of the same thing */
  type?: string;
  title?: string;
  patterns?: string[];
  pattern?: string | string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  callID?: string;
  messageID?: string;
  tool?: { messageID: string; callID: string };
}

export interface WireQuestionOption {
  label: string;
  description?: string;
}

export interface WireQuestionInfo {
  question: string;
  header?: string;
  options?: WireQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface WireQuestionRequest {
  id: string;
  sessionID: string;
  questions: WireQuestionInfo[];
  tool?: { messageID: string; callID: string };
}

export interface WireTodo {
  id: string;
  content: string;
  status: string;
}

export type OpencodeEvent =
  | { type: "message.updated"; properties: { info: WireMessage } }
  | { type: "message.part.updated"; properties: { part: WirePart; delta?: string } }
  | { type: "permission.asked" | "permission.updated"; properties: WirePermission }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: string } }
  | { type: "question.asked"; properties: WireQuestionRequest }
  | { type: "question.replied" | "question.rejected"; properties: { sessionID?: string; requestID: string } }
  | { type: "todo.updated"; properties: { sessionID: string; todos: WireTodo[] } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID?: string; error?: WireMessageError } }
  | { type: "session.compacted"; properties: { sessionID: string } }
  | { type: string; properties?: Record<string, unknown> };

export interface WireModel {
  id: string;
  name?: string;
  limit?: { context?: number; output?: number };
  status?: string;
}

export interface WireProvider {
  id: string;
  name?: string;
  models: Record<string, WireModel>;
}

export interface WireAgent {
  name: string;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  builtIn?: boolean;
}

export type PermissionAction = "allow" | "deny" | "ask";

/** `{ permission, pattern, action }` triples accepted by `POST /session`'s `permission`. */
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/**
 * The `permission` block of the user's own config as `GET /config` serves it
 * (`Config.Permission`, opencode 1.1.36): one entry per permission key, whose value is
 * either a bare action (the key's blanket default) or a `{pattern: action}` map. The
 * server has already normalised a top-level bare string into `{"*": action}`.
 */
export type WirePermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>;

/** The slice of `GET /config` this driver reads. */
export interface WireConfig {
  permission?: WirePermissionConfig;
}

export type PermissionReply = "once" | "always" | "reject";
