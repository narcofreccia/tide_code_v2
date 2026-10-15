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
import { readUserSandboxConfig, type UserSandboxConfig } from "./config-toml.ts";
import { ApprovalBroker } from "./approvals.ts";
import { AsyncQueue, deferred, type Deferred } from "./async-queue.ts";
import type { RequestId } from "./jsonrpc.ts";
import { collaborationModeFor, policyFor, writableRoots } from "./modes.ts";
import { CodexNormalizer } from "./normalize.ts";
import { rateLimitFromSnapshot } from "./rate-limits.ts";
import type { CodexConfig } from "./types.ts";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse.ts";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.ts";
import type { ThreadRevertParams } from "./generated/v2/ThreadRevertParams.ts";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.ts";
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
 *
 * R4: steer = `turn/steer` against the running turn (`expectedTurnId`), fork = `thread/fork`
 * at open, rollback = `thread/revert { beforeTurnId }`. Turn ids come from each `turn/start`
 * response; history older than this process (resume, fork) is read with `thread/turns/list`.
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
  /** the user's own sandbox/approval stance from config.toml, resolved once per session; modes only narrow it */
  #userConfig: UserSandboxConfig;
  #turnActive = false;
  #closed = false;
  #interruptRequested = false;
  /** codex turn ids of this session's `send()`s, oldest first */
  #turnIds: string[] = [];
  /** the running turn's id, once `turn/start` answered (undefined if it failed) */
  #turnStart: Deferred<string | undefined> | undefined;

  private constructor(env: DriverEnv, options: OpenSessionOptions, server: AppServer, model: string, userConfig: UserSandboxConfig) {
    this.#env = env;
    this.#options = options;
    this.#server = server;
    this.#model = model;
    this.#userConfig = userConfig;
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

    const userConfig = readUserSandboxConfig(config.codexHome, config.tomlReader);
    if (config.networkAccess !== undefined) userConfig.networkAccess = config.networkAccess;
    const policy = policyFor(options.mode, writableRoots(options), false, userConfig);
    if (options.resume !== undefined && options.forkFrom !== undefined) {
      server.close();
      throw new Error("invalid-params: resume and forkFrom are mutually exclusive");
    }
    let started: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse;
    try {
      started =
        options.forkFrom !== undefined
          ? await server.request<ThreadForkResponse>("thread/fork", {
              threadId: options.forkFrom,
              cwd: options.cwd,
              approvalPolicy: policy.approvalPolicy,
              sandbox: policy.sandbox,
              excludeTurns: true,
              ...(options.model ?? config.defaultModel ? { model: options.model ?? config.defaultModel } : {}),
              ...(options.systemPromptAppend ? { developerInstructions: options.systemPromptAppend } : {}),
            })
          : options.resume !== undefined
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
    } catch (error) {
      server.close(); // no session will own this child
      throw error;
    }

    session = new CodexSession(env, options, server, started.model ?? options.model ?? config.defaultModel ?? "", userConfig);
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
      this.#broker.decline(id, method, params);
    }
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("codex session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this codex session");
    this.#turnActive = true;
    this.#interruptRequested = false;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    const turnStart = deferred<string | undefined>();
    this.#turnStart = turnStart;
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      const started = self.#startTurn(input, mailbox, turnStart);
      try {
        for await (const event of mailbox.drain()) yield event;
        await started;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
        self.#turnStart = undefined;
        turnStart.resolve(undefined); // a steer still waiting on a turn that never started
      }
    }
    return stream();
  }

  async #startTurn(input: TurnInput, mailbox: AsyncQueue<NormalizedEvent>, turnStart: Deferred<string | undefined>): Promise<void> {
    const policy = policyFor(this.#options.mode, writableRoots(this.#options), false, this.#userConfig);
    try {
      const response = await this.#server.request<TurnStartResponse>("turn/start", {
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
      const turnId = response?.turn?.id;
      if (turnId !== undefined) this.#turnIds.push(turnId);
      turnStart.resolve(turnId);
      void this.#readRateLimits(mailbox);
    } catch (error) {
      turnStart.resolve(undefined);
      mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: error instanceof Error ? error.message : String(error) });
      mailbox.close();
    }
  }

  /**
   * `account/rateLimits/read` once per turn, best effort and never awaited: it needs a
   * ChatGPT login (an API-key or logged-out account just errors), and live updates arrive as
   * `account/rateLimits/updated` notifications anyway.
   */
  async #readRateLimits(mailbox: AsyncQueue<NormalizedEvent>): Promise<void> {
    try {
      const response = await this.#server.request<{ rateLimits?: Parameters<typeof rateLimitFromSnapshot>[0] }>("account/rateLimits/read", {});
      const rateLimit = rateLimitFromSnapshot(response?.rateLimits, Date.now());
      if (rateLimit && this.#mailbox === mailbox) mailbox.push({ type: "usage", rateLimit });
    } catch (error) {
      this.#env.log(`[codex] account/rateLimits/read unavailable: ${error instanceof Error ? error.message : String(error)}`);
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

  /**
   * `turn/steer` appends input to the running turn without interrupting it. The turn id is
   * the request's precondition, so a steer racing the turn's end fails on Codex's side and
   * the error reaches the caller.
   */
  async steer(input: TurnInput): Promise<void> {
    const threadId = this.nativeSessionId;
    const turnStart = this.#turnStart;
    if (this.#closed || !this.#turnActive || turnStart === undefined || threadId === undefined) throw new Error("no turn is running on this codex session");
    const expectedTurnId = this.#normalizer.turnId ?? (await turnStart.promise);
    if (expectedTurnId === undefined || !this.#turnActive) throw new Error("no turn is running on this codex session");
    const params: TurnSteerParams = { threadId, input: turnInput(input), expectedTurnId };
    await this.#server.request<TurnSteerResponse>("turn/steer", params);
  }

  /**
   * `thread/revert { beforeTurnId }` drops that turn and every later one from the thread's
   * persisted history (files are not touched; Tide's checkpoints own the worktree).
   */
  async rollback(turns: number): Promise<void> {
    if (this.#closed) throw new Error("codex session is closed");
    if (this.#turnActive) throw new Error("busy: cannot roll back while a turn is running");
    const threadId = this.nativeSessionId;
    if (turns <= 0 || threadId === undefined) return;
    const beforeTurnId = turns <= this.#turnIds.length ? this.#turnIds[this.#turnIds.length - turns] : await this.#nthLatestTurn(threadId, turns);
    if (beforeTurnId === undefined) throw new Error(`invalid-params: cannot roll back ${turns} turn(s); the codex thread holds fewer`);
    const params: ThreadRevertParams = { threadId, beforeTurnId };
    await this.#server.request("thread/revert", params);
    const cut = this.#turnIds.indexOf(beforeTurnId);
    this.#turnIds = cut >= 0 ? this.#turnIds.slice(0, cut) : [];
  }

  /** History from before this process (resumed or forked thread): ask Codex, newest first. */
  async #nthLatestTurn(threadId: string, n: number): Promise<string | undefined> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadTurnsListResponse = await this.#server.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId,
        sortDirection: "desc",
        limit: n,
        ...(cursor !== null ? { cursor } : {}),
      });
      ids.push(...page.data.map((turn) => turn.id));
      cursor = page.nextCursor;
    } while (ids.length < n && cursor !== null);
    return ids[n - 1];
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
