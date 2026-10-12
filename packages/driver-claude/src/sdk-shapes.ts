/**
 * Structural mirror of the subset of `@anthropic-ai/claude-agent-sdk`'s `SDKMessage`
 * union that the normalizer reads (sdk.d.ts, 0.3.296).
 *
 * Why re-declare instead of importing `SDKMessage`: the SDK's message types reach into
 * `@anthropic-ai/sdk`'s `BetaMessage`/`BetaRawMessageStreamEvent`, which are optional peer
 * types we do not install — importing them would make the whole union `any` and would make
 * hand/recorded JSON fixtures untypeable. These are the *declared adapter boundary* types
 * (CLAUDE.md §5); `session.ts` casts the SDK's messages to them in one place.
 */

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: string | { type: string; text?: string }[];
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string };

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeModelUsage {
  contextWindow?: number;
}

export interface SystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
}

export interface SystemOtherMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  /** permission_denied */
  tool_name?: string;
  tool_use_id?: string;
  message?: string;
  decision_reason?: string;
  /** api_retry */
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error?: string;
  /** compact_boundary */
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  /** task_started | task_updated | task_progress (background tasks / subagents) */
  task_id?: string;
  description?: string;
  subagent_type?: string;
  summary?: string;
  last_tool_name?: string;
  /** housekeeping tasks the CLI itself hides from the transcript */
  ambient?: boolean;
  skip_transcript?: boolean;
  patch?: { status?: string; description?: string; error?: string };
}

export interface AssistantMessage {
  type: "assistant";
  uuid?: string;
  session_id?: string;
  parent_tool_use_id: string | null;
  subagent_type?: string;
  task_description?: string;
  message: { id?: string; model?: string; content?: ContentBlock[] };
}

export interface UserMessage {
  type: "user";
  uuid?: string;
  session_id?: string;
  parent_tool_use_id: string | null;
  message: { content?: string | ContentBlock[] };
}

export interface StreamEventMessage {
  type: "stream_event";
  uuid?: string;
  session_id?: string;
  parent_tool_use_id: string | null;
  event:
    | { type: "message_start"; message?: { id?: string } }
    | { type: "content_block_start"; index: number; content_block?: { type: string } }
    | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; thinking?: string } }
    | { type: string; index?: number };
}

export interface ResultMessage {
  type: "result";
  subtype: string;
  session_id: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
  /** set when this turn re-runs/continues one a worker restart interrupted (SDKResult*.resume_reason) */
  resume_reason?: string;
  /** error results written before exiting on a known startup failure (SDKResultError.startup_failure_reason) */
  startup_failure_reason?: string;
}

/** SDKRateLimitInfo (sdk.d.ts). `unifiedWindows` is emitted by CLI 2.1.296 but not declared in the d.ts. */
export interface RateLimitInfoShape {
  status?: string; // allowed | allowed_warning | rejected
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number; // epoch seconds
  overageStatus?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  overageEnabled?: boolean;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

export interface RateLimitMessage {
  type: "rate_limit_event";
  rate_limit_info?: RateLimitInfoShape;
}

export type ClaudeMessage =
  | SystemInitMessage
  | SystemOtherMessage
  | AssistantMessage
  | UserMessage
  | StreamEventMessage
  | ResultMessage
  | RateLimitMessage
  | { type: string; subtype?: string };

/** `AskUserQuestion` input, as validated by the CLI's tool schema (sdk-tools.d.ts). */
export interface AskUserQuestionInputShape {
  questions: {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: { label: string; description?: string; preview?: string }[];
  }[];
  /**
   * "User answers collected by the permission component" — an optional field of the tool's
   * own input schema, keyed by question text. Setting it from `canUseTool.updatedInput` is
   * the only supported way for an SDK host to answer AskUserQuestion (verified against
   * Claude Code 2.1.251: allowing without it yields "The user did not answer the questions",
   * and narrowing `options` fails schema validation).
   */
  answers?: Record<string, string | string[]>;
}
