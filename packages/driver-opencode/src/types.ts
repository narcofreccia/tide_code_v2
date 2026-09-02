import type { OpencodeEvent, PermissionReply, PermissionRule, WireAgent, WireProvider } from "./wire.ts";

export interface OpencodeConfig {
  /** absolute path to the `opencode` binary; auto-detected when omitted */
  binaryPath?: string;
  /** `provider/model` id used when a thread does not pin one */
  defaultModel?: string;
  /** extra environment for the spawned server (merged over `process.env`) */
  env?: Record<string, string>;
  /** attach to an already running `opencode serve` instead of spawning one */
  serverUrl?: string;
  /**
   * Test seam: replaces the real HTTP client. Not user-facing — lets the session and
   * instance tests drive a scripted server without spawning one.
   */
  apiImpl?: OpencodeApi;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface PromptPart {
  type: "text" | "file";
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
}

/**
 * The slice of the opencode server this driver depends on. Implemented for real over
 * `@opencode-ai/sdk`'s typed client in `client.ts`; faked in tests.
 *
 * Every call carries `directory`: one server serves every working directory, and the
 * directory query parameter is what scopes sessions, events and tool execution to a
 * worktree (verified against opencode 1.1.36 — a server started in `/tmp` runs a session
 * whose `directory` is another repo, with tools resolving inside that repo).
 */
export interface OpencodeApi {
  createSession(input: { directory: string; title?: string; permission?: PermissionRule[] }): Promise<{ id: string }>;
  promptAsync(input: { directory: string; sessionId: string; agent: string; model?: ModelRef; system?: string; parts: PromptPart[] }): Promise<void>;
  abort(input: { directory: string; sessionId: string }): Promise<void>;
  respondPermission(input: { directory: string; sessionId: string; permissionId: string; reply: PermissionReply }): Promise<void>;
  respondQuestion(input: { directory: string; requestId: string; answers: string[][] }): Promise<void>;
  /** long-lived SSE subscription for one directory; ends when `signal` aborts */
  subscribe(input: { directory: string; signal: AbortSignal }): Promise<AsyncIterable<OpencodeEvent>>;
  providers(): Promise<{ providers: WireProvider[]; default: Record<string, string> }>;
  agents(input: { directory: string }): Promise<WireAgent[]>;
  /** registers an MCP server for a directory (`POST /mcp`); tools appear on the next turn */
  addMcpServer(input: { directory: string; name: string; command: string[]; env?: Record<string, string> }): Promise<void>;
  /**
   * Tears one down again (`POST /mcp/{name}/disconnect`). opencode 1.18's API has no *remove*:
   * disconnect closes the client, drops it from the directory's client map and leaves the
   * status entry as `disabled`, which is enough to stop the process and hide its tools.
   */
  disconnectMcpServer(input: { directory: string; name: string }): Promise<void>;
  health(): Promise<{ healthy: boolean; version?: string }>;
}
