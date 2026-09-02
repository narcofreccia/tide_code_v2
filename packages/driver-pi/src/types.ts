import type { NormalizedEvent } from "@tide/contracts";

export interface PiConfig {
  /** absolute path to the `pi` binary; auto-detected when omitted */
  binaryPath?: string;
  /** model id (`provider/id` or a pattern) used when a thread does not pin one */
  defaultModel?: string;
  /** extra environment for every spawned pi process (merged over `process.env`) */
  env?: Record<string, string>;
  /** extra `-e <path>` extensions loaded next to tide-bridge */
  extraExtensions?: string[];
}

/** The slice of `child_process.ChildProcess` this driver uses. Kept structural for tests. */
export interface ChildLike {
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): unknown;
  once(event: "exit" | "error", listener: (...args: never[]) => void): unknown;
}

/**
 * Test seam for the driver's wall-clock deadlines (the SIGKILL escalation), so tests drive
 * them deterministically instead of sleeping.
 */
export interface TimerLike {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export type SpawnLike = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Injected seams. Tests replace them; production wires node's `spawn` and global `fetch`. */
export interface PiDeps {
  spawn: SpawnLike;
  fetch: FetchLike;
  /** absolute path passed to `pi -e`; defaults to the built tide-bridge of @tide/pi-extensions */
  bridgePath?: string;
}

// ---- pi RPC wire shapes (docs/rpc.md of @earendil-works/pi-coding-agent 0.84.x) ----

export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PiUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  notifyType?: string;
}

/** Every other stdout line: agent events. Deliberately loose — unknown events pass through. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export type PiLine = PiResponse | PiUiRequest | PiEvent;

export interface PiTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  tokens?: PiTokens;
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface PiState {
  model?: { id?: string; name?: string; provider?: string; contextWindow?: number } | null;
  sessionFile?: string;
  sessionId?: string;
  isStreaming?: boolean;
}

export interface PiModel {
  id: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
}

export type Emit = (event: NormalizedEvent) => void;
