import type {
  ApprovalDecision,
  DriverEnv,
  HarnessTurnHandle,
  NormalizedEvent,
  OpenSessionOptions,
  ProviderSession,
  ReconfigureResult,
  SessionSettings,
  SteerTarget,
  TurnInput,
} from "@tide/contracts";
import { AppServer, mergedEnv } from "./app-server.ts";
import { readUserSandboxConfig, type UserSandboxConfig } from "./config-toml.ts";
import { ApprovalBroker } from "./approvals.ts";
import { AsyncQueue, deferred, type Deferred } from "./async-queue.ts";
import type { RequestId } from "./jsonrpc.ts";
import { resumeRefusal } from "./resume-refused.ts";
import { collaborationModeFor, policyFor, writableRoots } from "./modes.ts";
import { CodexNormalizer } from "./normalize.ts";
import { isNoActiveTurn, missedEndNotice } from "./missed-end.ts";
import { CodexHarnessTurn, CONTINUED_REASON, isIdleActivity, pendingRequest, requestReason } from "./harness-turn.ts";
import { TurnLedger } from "./turn-ledger.ts";
import { withInstance } from "./instance-config.ts";
import { rateLimitsFromSnapshot } from "./rate-limits.ts";
import { fetchSkills, matchSkill, type CodexSkill } from "./skills.ts";
import type { CodexConfig } from "./types.ts";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse.ts";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.ts";
import type { ThreadRollbackParams } from "./types.ts";
import type { ThreadRevertParams } from "./generated/v2/ThreadRevertParams.ts";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.ts";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts";
import type { UserInput } from "./generated/v2/UserInput.ts";

/** The turn a `turn/steer` or `turn/interrupt` targeted, captured before the request went out. */
interface TargetTurn {
  mailbox: AsyncQueue<NormalizedEvent> | undefined;
  harness: CodexHarnessTurn | undefined;
  turnId: string;
}

/** Fallback with no listeners wired: cap on sub-agent rows held between turns; requests are always held. */
const MAX_HELD_EVENTS = 500;

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
 *
 * R14 (`caps.harnessTurns`): a sub-agent can outlive the turn that spawned it. Between turns its
 * rows go out live through `onIdleActivity`, and its approval or question opens a harness turn
 * (see `harness-turn.ts`) so the card reaches the user at once.
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
  /** R8: reasoning effort for the next turns; undefined = the model's default */
  #effort: string | undefined;
  /** R8: this cwd's skills, fetched lazily the first time a turn starts with `/` */
  #skills: Promise<CodexSkill[]> | undefined;
  /** the user's own sandbox/approval stance from config.toml, resolved once per session; modes only narrow it */
  #userConfig: UserSandboxConfig;
  #turnActive = false;
  #closed = false;
  #interruptRequested = false;
  /** the turns the server records for this session (sends and harness turns), for `rollback` */
  #ledger = new TurnLedger();
  /** the turn Codex or a sub-agent started with no `send` running, while it is open */
  #harness: CodexHarnessTurn | undefined;
  #harnessListener: ((turn: HarnessTurnHandle) => void) | undefined;
  #idleListener: ((event: NormalizedEvent) => void) | undefined;
  /** sub-agents first seen in the turn now running: only their requests can nest under their row */
  #turnChildren = new Set<string>();
  #seenChildren = new Set<string>();
  /** the sub-agent whose server request is being parked right now (names the harness turn) */
  #requester: string | undefined;
  /** codex < 0.162 answers `thread/revert` with "unknown variant"; use `thread/rollback` from then on */
  #revertUnsupported = false;
  /** the running turn's id, once `turn/start` answered (undefined if it failed) */
  #turnStart: Deferred<string | undefined> | undefined;
  /** with no listeners wired: sub-agent rows and request cards that arrived between turns, shown when the next turn starts */
  #held: NormalizedEvent[] = [];

  private constructor(env: DriverEnv, options: OpenSessionOptions, server: AppServer, model: string, userConfig: UserSandboxConfig, threadId: string) {
    this.#env = env;
    this.#options = options;
    this.#server = server;
    this.#model = model;
    this.#effort = options.effort;
    this.#userConfig = userConfig;
    this.#normalizer = new CodexNormalizer({
      threadId,
      onUnknown: (method) => {
        if (process.env["TIDE_DEBUG_CODEX"]) env.log(`[codex] unhandled notification ${method}`);
      },
    });
    this.#broker = new ApprovalBroker(
      (event) => this.#emit(event),
      (id, result) => this.#server.respond(id, result),
      (id, code, message) => this.#server.respondError(id, code, message),
      (requestId) => this.#requestSettled(requestId),
    );
  }

  static async open(rawConfig: CodexConfig, env: DriverEnv, options: OpenSessionOptions, binaryPath: string): Promise<CodexSession> {
    const config = withInstance(rawConfig, env);
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
      throw options.resume !== undefined && options.forkFrom === undefined ? resumeRefusal(error) : error;
    }

    session = new CodexSession(env, options, server, started.model ?? options.model ?? config.defaultModel ?? "", userConfig, started.thread.id);
    session.nativeSessionId = started.thread.id;
    for (const buffered of notifications) session.#notification(buffered.method, buffered.params);
    for (const buffered of requests) session.#request(buffered.method, buffered.params, buffered.id);
    return session;
  }

  onHarnessTurn(listener: (turn: HarnessTurnHandle) => void): void {
    this.#harnessListener = listener;
  }

  onIdleActivity(listener: (event: NormalizedEvent) => void): void {
    this.#idleListener = listener;
  }

  /** A harness turn is open, or a sub-agent is still working (it can outlive the turn that spawned it). */
  hasBackgroundWork(): boolean {
    return this.#harness !== undefined || this.#normalizer.runningChildren().length > 0;
  }

  /**
   * Where an event goes: the running `send`, else the open harness turn. Between turns a
   * sub-agent's request opens a harness turn and its other rows are idle activity. With no
   * listeners wired, those rows and requests are held and replayed when the next `send` starts
   * (the request stays parked, nothing is answered on the user's behalf). The rest of the
   * between-turn chatter (rate limits, status) is dropped.
   */
  #emit(event: NormalizedEvent): void {
    this.#noteChild(event);
    if (this.#mailbox) {
      this.#mailbox.push(event);
      return;
    }
    if (this.#harness) {
      this.#toHarness(this.#harness, event);
      return;
    }
    if (this.#closed) return;
    const request = pendingRequest(event);
    if (request !== undefined && this.#harnessListener !== undefined) {
      this.#toHarness(this.#openHarness(requestReason(request.kind === "user-input" ? "user-input" : "approval", this.#requester)), event);
      return;
    }
    if (this.#idleListener !== undefined && isIdleActivity(event)) {
      try {
        this.#idleListener(event);
      } catch (error) {
        this.#env.log(`[codex] idle activity listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    this.#hold(event);
  }

  #hold(event: NormalizedEvent): void {
    if (event.type !== "activity") return;
    const activity = event.activity;
    const request = activity.kind === "approval" || activity.kind === "user-input";
    if (!request && activity.kind !== "child" && activity.parentToolUseId === undefined) return;
    if (!request && this.#held.length >= MAX_HELD_EVENTS) return; // a long unattended child: requests are kept, further rows are dropped
    if (request) this.#env.log(`[codex] ${activity.kind} request ${activity.requestId} arrived between turns (sub-agent ${this.#requester ?? "unknown"}); holding it for the next turn`);
    this.#held.push(event);
  }

  /** A child row seen for the first time inside a turn belongs to that turn on the server. */
  #noteChild(event: NormalizedEvent): void {
    if (event.type !== "activity" || event.activity.kind !== "child") return;
    const key = event.activity.childKey;
    if (this.#seenChildren.has(key)) return;
    this.#seenChildren.add(key);
    if (this.#mailbox !== undefined || this.#harness !== undefined) this.#turnChildren.add(key);
  }

  /**
   * The parent's own `turn/completed` inside a harness turn ends it, unless a sub-agent's request
   * is still open: then the turn stays open until that is answered (settling it would close the
   * card unanswered), and settles with the parent turn's status.
   */
  #toHarness(turn: CodexHarnessTurn, event: NormalizedEvent): void {
    if (event.type !== "settled") {
      turn.push(event);
      return;
    }
    turn.nativeSettled = event;
    if (turn.requests.size === 0) this.#endHarness(turn, event);
  }

  #openHarness(reason: string, nativeTurnId?: string): CodexHarnessTurn {
    const turn = new CodexHarnessTurn(reason, this.#ledger.add(nativeTurnId));
    this.#harness = turn;
    this.#turnChildren.clear();
    this.#interruptRequested = false;
    try {
      this.#harnessListener?.({ reason, events: turn.mailbox.drain(), key: turn.key, dismiss: () => this.#ledger.remove(turn.entry) });
    } catch (error) {
      this.#env.log(`[codex] harness-turn listener threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    return turn;
  }

  #endHarness(turn: CodexHarnessTurn, settled: Extract<NormalizedEvent, { type: "settled" }>): void {
    if (this.#harness === turn) this.#harness = undefined;
    turn.settle(settled);
  }

  /** A parked request was answered or withdrawn: a harness turn held open only by requests settles. */
  #requestSettled(requestId: string): void {
    const turn = this.#harness;
    if (turn === undefined || !turn.requests.delete(requestId) || turn.requests.size > 0) return;
    if (turn.nativeTurnId !== undefined && turn.nativeSettled === undefined) return; // the parent's own turn still runs
    this.#endHarness(turn, turn.nativeSettled ?? { type: "settled", status: this.#interruptRequested ? "interrupted" : "completed" });
  }

  /** `turn/started` on the session's thread with no `send` running: Codex started a turn by itself. */
  #parentTurnStarted(turnId: string): void {
    if (this.#harness !== undefined) {
      this.#harness.entry.native ??= turnId;
      return;
    }
    if (this.#harnessListener === undefined) return; // nobody listens: its events are dropped as before
    this.#openHarness(CONTINUED_REASON, turnId);
  }

  /** The app-server is gone: end whatever turn was running rather than waiting forever. */
  #died(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.cancelAll();
    const settled: Extract<NormalizedEvent, { type: "settled" }> = { type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: reason };
    this.#mailbox?.push(settled);
    this.#mailbox?.close();
    if (this.#harness) this.#endHarness(this.#harness, settled);
  }

  #notification(method: string, params: unknown): void {
    if (method === "serverRequest/resolved") {
      // Codex dropped a request nobody answered (its turn ended): close the card
      const requestId = (params as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") this.#broker.withdraw(String(requestId));
    }
    const before = this.#normalizer.turnId;
    for (const event of this.#normalizer.next(method, params)) {
      if (event.type === "session") this.nativeSessionId = event.nativeSessionId;
      this.#emit(event);
      if (event.type === "settled" && this.#mailbox !== undefined) {
        // the turn is over from here on, though its reader may still be draining: what follows is between turns
        this.#mailbox.close();
        this.#mailbox = undefined;
      }
    }
    const after = this.#normalizer.turnId;
    if (before === undefined && after !== undefined && this.#mailbox === undefined && !this.#closed) this.#parentTurnStarted(after);
  }

  #request(method: string, params: unknown, id: RequestId): void {
    const payload = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const threadId = typeof payload["threadId"] === "string" ? payload["threadId"] : undefined;
    // A card nests under its sub-agent's row only when that row belongs to the turn now running:
    // the server files a nested card under the row's turn, and a settled turn refuses a pending card.
    const parent = this.#normalizer.parentFor(threadId);
    const nests = parent !== undefined && (this.#mailbox !== undefined || this.#harness !== undefined) && this.#turnChildren.has(parent);
    const requester = parent !== undefined && !nests ? (this.#normalizer.childName(parent) ?? parent) : undefined;
    this.#requester = requester;
    let handled: boolean;
    try {
      handled = this.#broker.handle({ method, params: payload, id, diffFor: (itemId) => this.#normalizer.patchFor(itemId), parentToolUseId: nests ? parent : undefined, requester });
    } finally {
      this.#requester = undefined;
    }
    if (!handled) {
      this.#env.log(`[codex] declining unmodelled server request ${method}`);
      this.#broker.decline(id, method, params);
    }
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("codex session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this codex session");
    this.#turnActive = true;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    const turnStart = deferred<string | undefined>();
    this.#turnStart = turnStart;
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      try {
        // a harness turn is open (a sub-agent's request, or Codex's own turn): this send waits for it
        while (self.#harness) await self.#harness.done;
        if (self.#closed) {
          yield { type: "settled", status: "interrupted", error: "codex session is closed" };
          return;
        }
        self.#interruptRequested = false;
        self.#turnChildren.clear();
        for (const event of self.#held.splice(0)) mailbox.push(event);
        self.#mailbox = mailbox;
        const started = self.#startTurn(input, mailbox, turnStart);
        for await (const event of mailbox.drain()) yield event;
        await started;
      } finally {
        self.#turnActive = false;
        if (self.#mailbox === mailbox) self.#mailbox = undefined;
        self.#turnStart = undefined;
        turnStart.resolve(undefined); // a steer still waiting on a turn that never started
      }
    }
    return stream();
  }

  async #startTurn(input: TurnInput, mailbox: AsyncQueue<NormalizedEvent>, turnStart: Deferred<string | undefined>): Promise<void> {
    const policy = policyFor(this.#options.mode, writableRoots(this.#options), false, this.#userConfig);
    try {
      const skills = input.text.trimStart().startsWith("/") ? await this.#loadSkills() : [];
      const response = await this.#server.request<TurnStartResponse>("turn/start", {
        threadId: this.nativeSessionId,
        input: turnInput(input, skills),
        ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
        cwd: this.#options.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.#model !== "" ? { model: this.#model } : {}),
        // ALWAYS sent, pinned model or not: `collaborationMode` is the only thing that puts
        // Codex in plan mode, and gating it on a pinned model silently dropped plan mode for
        // every thread on the default model. `settings.model` is the thread's resolved model
        // (from `thread/start`), which is what Codex would have used anyway.
        collaborationMode: collaborationModeFor(this.#options.interaction, this.#model, this.#effort),
      });
      const turnId = response?.turn?.id;
      if (turnId !== undefined) this.#ledger.add(turnId);
      turnStart.resolve(turnId);
      void this.#readRateLimits(mailbox);
    } catch (error) {
      turnStart.resolve(undefined);
      mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: error instanceof Error ? error.message : String(error) });
      mailbox.close();
      if (this.#mailbox === mailbox) this.#mailbox = undefined;
    }
  }

  /** Never throws: a failed `skills/list` just means `/x` goes through as plain text. */
  #loadSkills(): Promise<CodexSkill[]> {
    this.#skills ??= fetchSkills(this.#server, this.#options.cwd).catch((error: unknown) => {
      this.#env.log(`[codex] skills/list failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    return this.#skills;
  }

  /**
   * `account/rateLimits/read` once per turn, best effort and never awaited: it needs a
   * ChatGPT login (an API-key or logged-out account just errors), and live updates arrive as
   * `account/rateLimits/updated` notifications anyway.
   */
  async #readRateLimits(mailbox: AsyncQueue<NormalizedEvent>): Promise<void> {
    try {
      const response = await this.#server.request<{ rateLimits?: Parameters<typeof rateLimitsFromSnapshot>[0] }>("account/rateLimits/read", {});
      if (this.#mailbox !== mailbox) return;
      for (const rateLimit of rateLimitsFromSnapshot(response?.rateLimits, Date.now())) mailbox.push({ type: "usage", rateLimit });
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
    this.#effort = settings.effort;
    return "applied";
  }

  /**
   * `turn/steer` appends input to the running turn without interrupting it. The turn id is
   * the request's precondition, so a steer racing the turn's end fails on Codex's side and
   * the error reaches the caller. A harness turn takes a steer only while the parent's own
   * Codex turn runs in it; one held open by a sub-agent's request has no turn to steer, so the
   * server queues the message behind it.
   */
  async steer(input: TurnInput, target?: SteerTarget): Promise<void> {
    const threadId = this.nativeSessionId;
    const harness = this.#harness;
    if (harness !== undefined) {
      if (target?.turnKey !== undefined && target.turnKey !== harness.key) throw new Error("that codex turn is no longer running");
      const expectedTurnId = harness.nativeSettled === undefined ? harness.nativeTurnId : undefined;
      if (this.#closed || threadId === undefined || expectedTurnId === undefined) throw new Error("no turn is running on this codex session (a sub-agent's request is waiting)");
      const params: TurnSteerParams = { threadId, input: turnInput(input, (await this.#skills) ?? []), expectedTurnId };
      await this.#steerRequest(params, { mailbox: undefined, harness, turnId: expectedTurnId });
      return;
    }
    if (target?.turnKey !== undefined) throw new Error("that codex turn is no longer running");
    const turnStart = this.#turnStart;
    if (this.#closed || !this.#turnActive || turnStart === undefined || threadId === undefined) throw new Error("no turn is running on this codex session");
    const expectedTurnId = this.#normalizer.turnId ?? (await turnStart.promise);
    if (expectedTurnId === undefined || !this.#turnActive) throw new Error("no turn is running on this codex session");
    const params: TurnSteerParams = { threadId, input: turnInput(input, (await this.#skills) ?? []), expectedTurnId };
    await this.#steerRequest(params, { mailbox: this.#mailbox, harness: undefined, turnId: expectedTurnId });
  }

  /** The error always reaches the caller (the server queues the message as the next turn). */
  async #steerRequest(params: TurnSteerParams, target: TargetTurn): Promise<void> {
    try {
      await this.#server.request<TurnSteerResponse>("turn/steer", params);
    } catch (error) {
      if (isNoActiveTurn(error)) this.#missedEnd(target, "completed");
      throw error;
    }
  }

  /**
   * Codex says the turn a request targeted is over while Tide still holds it open. Codex writes a
   * turn's `turn/completed` before the answer to a later request on the same pipe, so that end was
   * missed: settle the turn here. Does nothing once that turn settled or another one took its place.
   */
  #missedEnd(target: TargetTurn, status: "completed" | "interrupted"): void {
    const running = this.#normalizer.turnId;
    if (running !== undefined && running !== target.turnId) return;
    const settled: Extract<NormalizedEvent, { type: "settled" }> = { type: "settled", status };
    const { mailbox, harness } = target;
    if (mailbox !== undefined && this.#mailbox === mailbox) {
      mailbox.push(missedEndNotice());
      mailbox.push(settled);
      mailbox.close();
      this.#mailbox = undefined;
    } else if (harness !== undefined && this.#harness === harness && harness.nativeSettled === undefined && harness.nativeTurnId === target.turnId) {
      harness.push(missedEndNotice());
      this.#toHarness(harness, settled);
    } else return;
    this.#normalizer.turnEnded();
  }

  /**
   * `thread/revert { beforeTurnId }` drops that turn and every later one from the thread's
   * persisted history (files are not touched; Tide's checkpoints own the worktree).
   */
  async rollback(turns: number): Promise<void> {
    if (this.#closed) throw new Error("codex session is closed");
    if (this.#turnActive || this.#harness !== undefined) throw new Error("busy: cannot roll back while a turn is running");
    const threadId = this.nativeSessionId;
    if (turns <= 0 || threadId === undefined) return;
    // harness turns opened for a sub-agent's request count for the server but have no Codex turn
    const plan = this.#ledger.plan(turns);
    if (plan.native === 0) {
      this.#ledger.drop(plan.local.length);
      return;
    }
    if (!this.#revertUnsupported) {
      const beforeTurnId = plan.older === 0 ? plan.local.find((entry) => entry.native !== undefined)?.native : await this.#nthLatestTurn(threadId, plan.native);
      if (beforeTurnId === undefined) throw new Error(`invalid-params: cannot roll back ${turns} turn(s); the codex thread holds fewer`);
      const params: ThreadRevertParams = { threadId, beforeTurnId };
      try {
        await this.#server.request("thread/revert", params);
        this.#ledger.drop(plan.local.length);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/unknown variant.{0,4}thread\/revert/.test(error.message)) throw error;
        this.#revertUnsupported = true;
      }
    }
    // 0.147 compatibility: the older `thread/rollback { numTurns }`
    const legacy: ThreadRollbackParams = { threadId, numTurns: plan.native };
    await this.#server.request("thread/rollback", legacy);
    this.#ledger.drop(plan.local.length);
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

  /**
   * Interrupts the parent's own turn. A harness turn held open only by a sub-agent's request has
   * no parent turn: the request is cancelled and the running sub-agents' turns are interrupted.
   */
  async interrupt(): Promise<void> {
    this.#interruptRequested = true;
    const harness = this.#harness;
    const requestOnly = harness !== undefined && harness.nativeTurnId === undefined;
    if (!requestOnly) this.#normalizer.markInterrupted();
    this.#broker.cancelAll();
    const threadId = this.nativeSessionId;
    if (threadId === undefined) return;
    const turnId = this.#normalizer.turnId;
    const targets = turnId !== undefined ? [{ threadId, turnId }] : requestOnly ? this.#normalizer.runningChildren().flatMap((child) => (child.turnId !== undefined ? [{ threadId: child.threadId, turnId: child.turnId }] : [])) : [];
    // only the parent's own turn can have a missed end to settle; sub-agent turns only end their rows
    const parentTurn: TargetTurn | undefined = turnId !== undefined ? { mailbox: this.#mailbox, harness: this.#mailbox === undefined ? harness : undefined, turnId } : undefined;
    for (const target of targets) {
      try {
        await this.#server.request("turn/interrupt", target);
      } catch (error) {
        this.#env.log(`[codex] interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
        if (parentTurn !== undefined && target.turnId === parentTurn.turnId && isNoActiveTurn(error)) this.#missedEnd(parentTurn, "interrupted");
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.cancelAll();
    this.#mailbox?.close();
    if (this.#harness) this.#endHarness(this.#harness, { type: "settled", status: "interrupted", error: "codex session closed" });
    this.#server.close();
  }
}

/** Codex takes an array of typed input parts; images ride as data URLs. */
export function turnInput(input: TurnInput, skills: CodexSkill[] = []): UserInput[] {
  const parts: UserInput[] = (input.images ?? []).map((image) => ({ type: "image", url: `data:${image.mediaType};base64,${image.data}` }));
  // R8: a leading `/<listed skill>` becomes Codex's native skill input + the remaining text;
  // an unmatched `/x` is sent verbatim (pass-through, the harness decides).
  const hit = matchSkill(input.text, skills);
  if (hit) {
    parts.push({ type: "skill", name: hit.skill.name, path: hit.skill.path });
    if (hit.rest !== "") parts.push({ type: "text", text: hit.rest, text_elements: [] });
    return parts;
  }
  parts.push({ type: "text", text: input.text, text_elements: [] });
  return parts;
}
