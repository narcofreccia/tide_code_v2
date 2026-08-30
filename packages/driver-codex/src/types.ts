import type { AskForApproval } from "./generated/v2/AskForApproval.ts";
import type { CollaborationMode } from "./generated/CollaborationMode.ts";
import type { SandboxMode } from "./generated/v2/SandboxMode.ts";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.ts";

export interface CodexConfig {
  /** absolute path to the `codex` binary; auto-detected when omitted */
  binaryPath?: string;
  /** model id used when a thread does not pin one */
  defaultModel?: string;
  /** extra environment for every spawned app-server (merged over `process.env`) */
  env?: Record<string, string>;
  /**
   * Test seam: replaces `node:child_process.spawn`. Not user-facing — lets the transport
   * and session tests drive a scripted app-server without launching one.
   */
  spawnImpl?: SpawnFn;
}

/** The slice of a spawned child process this driver depends on. */
export interface ChildLike {
  readonly stdin: { write: (data: string) => void } | null;
  readonly stdout: { on: (event: "data", listener: (chunk: unknown) => void) => void } | null;
  readonly stderr: { on: (event: "data", listener: (chunk: unknown) => void) => void } | null;
  on: (event: "exit" | "error", listener: (arg: unknown) => void) => void;
  kill: (signal?: NodeJS.Signals) => void;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;

/** Native knobs a `RuntimeMode` maps to (see `modes.ts`). */
export interface CodexPolicy {
  approvalPolicy: AskForApproval;
  /** `thread/start` takes the coarse mode… */
  sandbox: SandboxMode;
  /** …while `turn/start` takes the full policy object. */
  sandboxPolicy: SandboxPolicy;
}

export type { AskForApproval, CollaborationMode, SandboxMode, SandboxPolicy };
