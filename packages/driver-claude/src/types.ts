import type { ClaudeMessage, TranscriptEntry } from "./sdk-shapes.ts";

export interface ClaudeConfig {
  /** absolute path to the `claude` binary; auto-detected when omitted */
  binaryPath?: string;
  /** model id/alias used when a thread does not pin one */
  defaultModel?: string;
  /** extra environment for every spawned CLI (merged over `process.env`) */
  env?: Record<string, string>;
  /**
   * Test seam: replaces `@anthropic-ai/claude-agent-sdk`'s `query()`. Not user-facing —
   * lets the session tests drive a scripted CLI without spawning one.
   */
  queryImpl?: QueryFn;
  /** Test seam: replaces the SDK's `getSessionMessages()` (transcript reader used by rollback). */
  sessionMessagesImpl?: SessionMessagesFn;
}

export interface ContextUsageReport {
  totalTokens?: number;
  rawMaxTokens?: number;
  maxTokens?: number;
}

export interface SdkModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export interface SdkSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

/** The slice of the SDK's `Query` object this driver depends on. */
export interface QueryLike extends AsyncIterable<ClaudeMessage> {
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  supportedModels?: () => Promise<SdkModelInfo[]>;
  supportedCommands?: () => Promise<SdkSlashCommand[]>;
  /** flag-tier settings overlay; `{ effortLevel }` changes the reasoning effort in place */
  applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  getContextUsage?: () => Promise<ContextUsageReport>;
}

export type QueryFn = (params: { prompt: AsyncIterable<unknown> | string; options?: Record<string, unknown> }) => QueryLike;

/** The SDK's `getSessionMessages(sessionId, { dir, includeSystemMessages })`. */
export type SessionMessagesFn = (sessionId: string, options: { dir?: string; includeSystemMessages?: boolean }) => Promise<TranscriptEntry[]>;
