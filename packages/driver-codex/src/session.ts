import type {
  ApprovalDecision,
  DriverEnv,
  NormalizedEvent,
  OpenSessionOptions,
  ProviderSession,
  ReconfigureResult,
  SessionSettings,
  TurnInput,
} from "@tide/contracts";
import { AppServer, mergedEnv } from "./app-server.ts";
import { readSandboxNetworkAccess } from "./config-toml.ts";
import { ApprovalBroker } from "./approvals.ts";
import { AsyncQueue } from "./async-queue.ts";
import type { RequestId } from "./jsonrpc.ts";
import { collaborationModeFor, policyFor, writableRoots } from "./modes.ts";
import { CodexNormalizer } from "./normalize.ts";
import type { CodexConfig } from "./types.ts";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts";
import type { UserInput } from "./generated/v2/UserInput.ts";

/**
 * One long-lived `codex app-server` child per Tide thread, killed on `close()`.
 *
 * Chosen over one process per turn because the Codex thread, its MCP servers and its
 * approval round-trips all live in that process; respawning per turn would restart every
 * MCP server and lose the parked server requests. The cost is that `send()` runs strictly
 * one turn at a time (see the `busy` guard).
 */
export class CodexSession implements ProviderSession {
  nativeSessionId: string | undefined;

  #env: DriverEnv;
  #options: OpenSessionOptions;
  #server: AppServer;
  #broker: ApprovalBroker;
  #normalizer: CodexNormalizer;
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;
  #model: string;
  /** the user's `[sandbox_workspace_write] network_access`, resolved once per session */
  #networkAccess: boolean;
  #turnActive = false;
  #closed = false;
  #interruptRequested = false;

  private constructor(env: DriverEnv, options: OpenSessionOptions, server: AppServer, model: string, networkAccess: boolean) {
    this.#env = env;
    this.#options = options;
    this.#server = server;
    this.#model = model;
    this.#networkAccess = networkAccess;
    this.#normalizer = new CodexNormalizer({
      onUnknown: (method) => {
        if (process.env["TIDE_DEBUG_CODEX"]) env.log(`[codex] unhandled notification ${method}`);
      },
    });
    this.#broker = new ApprovalBroker(
      (event) => this.#emit(event),
      (id, result) => this.#server.respond(id, result),
      (id, code, message) => this.#server.respondError(id, code, message),
    );
  }

  static async open(config: CodexConfig, env: DriverEnv, options: OpenSessionOptions, binaryPath: string): Promise<CodexSession> {
    const notifications: { method: string; params: unknown }[] = [];
    const requests: { method: string; params: unknown; id: RequestId }[] = [];
    let session: CodexSession | undefined;

    const server = await AppServer.start({
      binaryPath,
      cwd: options.cwd,
      env: mergedEnv(config, options.env),
      mcpServers: options.mcpServers,
      ...(config.spawnImpl ? { spawn: config.spawnImpl } : {}),
      log: (message) => env.log(message),
      // Buffer anything that arrives before the constructor has run.
      onNotification: (method, params) => (session ? session.#notification(method, params) : notifications.push({ method, params })),
      onRequest: (method, params, id) => (session ? session.#request(method, params, id) : requests.push({ method, params, id })),
      // The child can die at any point, including after `turn/start` has already resolved —
      // rejecting pending JSON-RPC calls would then settle nothing and the turn would hang.
      onExit: (reason) => {
        if (session) session.#died(reason);
      },
    });

    const networkAccess = config.networkAccess ?? readSandboxNetworkAccess(config.codexHome, config.tomlReader);
    const policy = policyFor(options.mode, writableRoots(options), networkAccess);
    const started =
      options.resume !== undefined
        ? await server.request<ThreadResumeResponse>("thread/resume", {
            threadId: options.resume,
            cwd: options.cwd,
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandbox,
            ...(options.model ?? config.defaultModel ? { model: options.model ?? config.defaultModel } : {}),
            ...(options.systemPromptAppend ? { developerInstructions: options.systemPromptAppend } : {}),
          })
        : await server.request<ThreadStartResponse>("thread/start", {
            cwd: options.cwd,
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandbox,
            ...(options.model ?? config.defaultModel ? { model: options.model ?? config.defaultModel } : {}),
            ...(options.systemPromptAppend ? { developerInstructions: options.systemPromptAppend } : {}),
          });

    session = new CodexSession(env, options, server, started.model ?? options.model ?? config.defaultModel ?? "", networkAccess);
    session.nativeSessionId = started.thread.id;
    for (const buffered of notifications) session.#notification(buffered.method, buffered.params);
    for (const buffered of requests) session.#request(buffered.method, buffered.params, buffered.id);
    return session;
  }

  #emit(event: NormalizedEvent): void {
    this.#mailbox?.push(event);
  }

  /** The app-server is gone: end whatever turn was running rather than waiting forever. */
  #died(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.cancelAll();
    this.#mailbox?.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: reason });
    this.#mailbox?.close();
  }

  #notification(method: string, params: unknown): void {
    for (const event of this.#normalizer.next(method, params)) {
      if (event.type === "session") this.nativeSessionId = event.nativeSessionId;
      this.#emit(event);
      if (event.type === "settled") this.#mailbox?.close();
    }
  }

  #request(method: string, params: unknown, id: RequestId): void {
    const payload = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const handled = this.#broker.handle({ method, params: payload, id, diffFor: (itemId) => this.#normalizer.patchFor(itemId) });
    if (!handled) {
      this.#env.log(`[codex] declining unmodelled server request ${method}`);
      this.#broker.reject(id, method);
    }
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("codex session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this codex session");
    this.#turnActive = true;
    this.#interruptRequested = false;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      const started = self.#startTurn(input, mailbox);
      try {
        for await (const event of mailbox.drain()) yield event;
        await started;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
      }
    }
    return stream();
  }

  async #startTurn(input: TurnInput, mailbox: AsyncQueue<NormalizedEvent>): Promise<void> {
    const policy = policyFor(this.#options.mode, writableRoots(this.#options), this.#networkAccess);
    try {
      await this.#server.request<TurnStartResponse>("turn/start", {
        threadId: this.nativeSessionId,
        input: turnInput(input),
        cwd: this.#options.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.#model !== "" ? { model: this.#model } : {}),
        // ALWAYS sent, pinned model or not: `collaborationMode` is the only thing that puts
        // Codex in plan mode, and gating it on a pinned model silently dropped plan mode for
        // every thread on the default model. `settings.model` is the thread's resolved model
        // (from `thread/start`), which is what Codex would have used anyway.
        collaborationMode: collaborationModeFor(this.#options.interaction, this.#model),
      });
    } catch (error) {
      mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: error instanceof Error ? error.message : String(error) });
      mailbox.close();
    }
  }

  /**
   * Codex takes model, approval/sandbox policy and collaboration (plan) mode **per turn** on
   * `turn/start`, so nothing has to be reopened: the new settings are stored and the next
   * turn carries them.
   */
  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    this.#options = { ...this.#options, mode: settings.mode, interaction: settings.interaction, ...(settings.model !== undefined ? { model: settings.model } : {}) };
    if (settings.model !== undefined && settings.model !== "") this.#model = settings.model;
    return "applied";
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    this.#broker.respondApproval(requestId, decision);
  }

  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    this.#broker.respondUserInput(requestId, answers);
  }

  async interrupt(): Promise<void> {
    this.#interruptRequested = true;
    this.#normalizer.markInterrupted();
    this.#broker.cancelAll();
    const turnId = this.#normalizer.turnId;
    if (turnId === undefined || this.nativeSessionId === undefined) return;
    try {
      await this.#server.request("turn/interrupt", { threadId: this.nativeSessionId, turnId });
    } catch (error) {
      this.#env.log(`[codex] interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.cancelAll();
    this.#mailbox?.close();
    this.#server.close();
  }
}

/** Codex takes an array of typed input parts; images ride as data URLs. */
export function turnInput(input: TurnInput): UserInput[] {
  const parts: UserInput[] = (input.images ?? []).map((image) => ({ type: "image", url: `data:${image.mediaType};base64,${image.data}` }));
  parts.push({ type: "text", text: input.text, text_elements: [] });
  return parts;
}
