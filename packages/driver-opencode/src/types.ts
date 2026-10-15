import type {
  FormValue,
  ModelRef,
  OpencodeEvent,
  PermissionReply,
  PermissionRule,
  WireAgent,
  WireConfigEntry,
  WireMessage,
  WireModel,
  WireSession,
} from "./wire.ts";

export interface OpencodeConfig {
  /** absolute path to an OpenCode 2 `opencode` binary; auto-detected when omitted */
  binaryPath?: string;
  /** `provider/model` id used when a thread does not pin one */
  defaultModel?: string;
  /** extra environment for a spawned private server (merged over `process.env`) */
  env?: Record<string, string>;
  /** attach to this server URL instead of discovering the shared service */
  serverUrl?: string;
  /** Basic-auth password for `serverUrl` (user `opencode`) */
  serverPassword?: string;
  /**
   * `auto` (default): attach to the user's running shared service (`opencode service`), else
   * spawn a private `opencode serve`. `standalone`: always spawn the private server.
   */
  attach?: "auto" | "standalone";
  /** service registration file; defaults to `$XDG_STATE_HOME/opencode/service.json` */
  serviceFile?: string;
  /**
   * Test seam: replaces the real HTTP client. Not user-facing — lets the session and
   * instance tests drive a scripted server without spawning one.
   */
  apiImpl?: OpencodeApi;
  /**
   * Test seam: replaces the global `fetch` the HTTP client uses (transport-replay tests inject
   * a recorded transcript here, with `serverUrl` set so no server is discovered or spawned).
   */
  fetchImpl?: typeof fetch;
}

export type { ModelRef };

/** One file attachment of a prompt (`PromptInput.FileAttachment`); images go as `data:` URIs. */
export interface PromptFile {
  uri: string;
  name?: string;
}

/**
 * The slice of the OpenCode 2 server this driver depends on. Implemented over plain `fetch`
 * in `client.ts`; faked in tests.
 *
 * v2 sessions carry their own `location.directory`, so session routes need no directory;
 * catalog/config/MCP routes are scoped with `?location[directory]=` (deepObject query).
 */
export interface OpencodeApi {
  createSession(input: { directory: string; title?: string; agent?: string; model?: ModelRef; permissions?: PermissionRule[]; metadata?: Record<string, unknown> }): Promise<WireSession>;
  getSession(input: { sessionId: string }): Promise<WireSession>;
  /** `PATCH /api/session/:id` — replaces the session ruleset in place */
  setPermissions(input: { sessionId: string; permissions: PermissionRule[] }): Promise<void>;
  switchAgent(input: { sessionId: string; agent: string }): Promise<void>;
  switchModel(input: { sessionId: string; model: ModelRef }): Promise<void>;
  /** durable per-session instruction entry (`PUT …/instructions/entries/:key`) */
  putInstruction(input: { sessionId: string; key: string; value: unknown }): Promise<void>;
  /**
   * `POST /api/session/:id/prompt` admits one input into the session inbox and answers its
   * `SessionInbox.User` (whose `id` becomes the user message id). `delivery` defaults to `steer`
   * server-side: promoted at the next step boundary of a running execution, or starts one.
   * The run itself is observed on the event stream.
   */
  prompt(input: { sessionId: string; text: string; files?: PromptFile[]; delivery?: "steer" | "queue" }): Promise<{ id?: string } | undefined>;
  /** `GET /api/session/:id/message` — one page, newest first unless a cursor says otherwise */
  messages(input: { sessionId: string; limit: number; cursor?: string }): Promise<{ data: WireMessage[]; cursor?: { next?: string | null } }>;
  /** `POST /api/session/:id/fork` — a new session with the history before `before` (all of it when omitted) */
  fork(input: { sessionId: string; before?: string }): Promise<WireSession>;
  /** `POST /api/session/:id/revert/stage` — `files: false` leaves the worktree alone */
  revertStage(input: { sessionId: string; messageId: string; files: boolean }): Promise<void>;
  /** `POST /api/session/:id/revert/commit` — deletes every message from the staged boundary on */
  revertCommit(input: { sessionId: string }): Promise<void>;
  /** `POST /api/session/:id/move` — relocates the session to another directory of the project */
  moveSession(input: { sessionId: string; directory: string }): Promise<void>;
  /** `POST /api/experimental/session/:id/wait` — resolves once the session's agent loop is idle */
  waitIdle(input: { sessionId: string }): Promise<void>;
  /** `DELETE /api/session/:id` */
  removeSession(input: { sessionId: string }): Promise<void>;
  interrupt(input: { sessionId: string }): Promise<void>;
  replyPermission(input: { sessionId: string; requestId: string; decision: PermissionReply; message?: string }): Promise<void>;
  replyForm(input: { sessionId: string; formId: string; answer: Record<string, FormValue> }): Promise<void>;
  cancelForm(input: { sessionId: string; formId: string }): Promise<void>;
  /** the server-wide SSE stream (`GET /api/event`); ends when `signal` aborts */
  subscribe(input: { signal: AbortSignal }): Promise<AsyncIterable<OpencodeEvent>>;
  models(input: { directory: string }): Promise<WireModel[]>;
  defaultModel(input: { directory: string }): Promise<WireModel | undefined>;
  agents(input: { directory: string }): Promise<WireAgent[]>;
  /** the user's config entries in load order (never written by Tide) */
  config(input: { directory: string }): Promise<WireConfigEntry[]>;
  addMcpServer(input: { directory: string; name: string; command: string[]; env?: Record<string, string> }): Promise<void>;
  removeMcpServer(input: { directory: string; name: string }): Promise<void>;
  info(): Promise<{ version: string; pid: number }>;
}
