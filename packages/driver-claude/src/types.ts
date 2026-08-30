import type { ClaudeMessage } from "./sdk-shapes.ts";

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
}

/** The slice of the SDK's `Query` object this driver depends on. */
export interface QueryLike extends AsyncIterable<ClaudeMessage> {
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
  supportedModels?: () => Promise<SdkModelInfo[]>;
  getContextUsage?: () => Promise<ContextUsageReport>;
}

export type QueryFn = (params: { prompt: AsyncIterable<unknown> | string; options?: Record<string, unknown> }) => QueryLike;
