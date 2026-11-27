import type { ApprovalDecision, DriverEnv, HarnessTurnHandle, NormalizedEvent, OpenSessionOptions, ProviderSession, ReconfigureResult, SessionSettings, SlashCommandInfo, SteerTarget, TurnInput, TurnUsage } from "@tide/contracts";
import { elicitationForm } from "@tide/contracts";
import type { TranscriptUsageReader } from "./antigravity-usage.ts";
import { AsyncQueue, deferred, type Deferred } from "./async-queue.ts";
import { FsPolicy } from "./fs.ts";
import { AcpConnection, RpcError, rpcError } from "./jsonrpc.ts";
import { AcpNormalizer, toolDiff, toolInput, toolName } from "./normalize.ts";
import { decisionOption, planPermission } from "./permissions.ts";
import { answerOption, isQuestionOptions, permissionQuestion, userInputQuestions, userInputResult, type AcpUserInputRequest, type UserInputQuestion } from "./questions.ts";
import { AcpSettings } from "./settings.ts";
import { toAcpMcpServers } from "./spawn.ts";
import {
  ACP_ERROR,
  type AcpConfig,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpQuirks,
  type AcpPermissionRequest,
  type AcpPromptUsage,
  type AcpSessionUpdate,
  type AcpStopReason,
  type ChildLike,
  type TimerLike,
} from "./types.ts";

/**
 * One ACP agent process per Tide thread. `start()` runs `initialize` and `session/new` (or
 * `session/load` when resuming); `send()` is one `session/prompt` whose `stopReason` settles
 * the turn. The agent calls back for permissions (held until the user answers, or answered
 * by the runtime mode) and for file reads/writes (served inside the worktree only).
 */

export const PROTOCOL_VERSION = 1;
export const INITIALIZE_TIMEOUT_MS = 90_000;

interface ActiveHarnessTurn {
  key: string;
  mailbox: AsyncQueue<NormalizedEvent>;
}

export function clientInitialize(version: string, quirks?: AcpQuirks): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    // `elicitation.form`: agents that support it (Antigravity's ask_question) send questions as
    // `elicitation/create` instead of writing them into the chat and ending the turn
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: quirks?.advertiseFsWrite !== false }, terminal: false, elicitation: { form: {} } },
    clientInfo: { name: "tide", version },
  };
}

/** The agent answered `auth_required`: the instance turns this into `loggedIn: false`. */
export class AcpAuthRequiredError extends Error {
  readonly hint: string;
  constructor(hint: string) {
    super(hint);
    this.hint = hint;
  }
}

/** `_meta` carrying the system prompt at the quirk's path; undefined = use the first-prompt block. */
export function systemPromptMeta(quirks: AcpQuirks | undefined, text: string | undefined): Record<string, unknown> | undefined {
  const path = quirks?.systemPromptMeta;
  if (!path || path.length === 0 || (text ?? "").trim() === "") return undefined;
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), text) as Record<string, unknown>;
}

export function authHint(label: string, init: AcpInitializeResult | undefined): string {
  const method = (init?.authMethods ?? []).find((entry) => typeof entry.description === "string" && entry.description !== "");
  return method?.description ? `${label} needs a login: ${method.description}` : `${label} needs a login: run its login command in a terminal, then retry`;
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof RpcError && (error.code === ACP_ERROR.authRequired || /auth(entication)? required|not (logged|signed) in/i.test(error.message));
}

interface PendingApproval {
  options: AcpPermissionRequest["options"];
  answer: Deferred<string | undefined>;
}

/** A question waiting for `respondUserInput`; undefined answers = cancelled. */
interface PendingInput {
  answer: Deferred<Record<string, unknown> | undefined>;
}

export interface SessionContext {
  config: AcpConfig;
  env: DriverEnv;
  label: string;
  timers?: TimerLike;
  initializeTimeoutMs?: number;
  /** told about the agent's capabilities and auth problems (status cache) */
  onInitialized?: (init: AcpInitializeResult) => void;
  onAuthRequired?: (hint: string) => void;
  onCommands?: (commands: SlashCommandInfo[]) => void;
  /** the agent reported context usage (caps.contextUsage is learned, not declared) */
  onContextUsage?: () => void;
  /** fallback per-turn token usage reader when the agent omits `PromptResponse.usage` */
  transcriptUsage?: TranscriptUsageReader;
}

export class AcpSession implements ProviderSession {
  nativeSessionId: string | undefined;
  /** a resume was asked for but a new session opened instead; one line why (SPI `resumeFailed`) */
  resumeFailed: string | undefined;
  init: AcpInitializeResult | undefined;
  settings: AcpSettings | undefined;

  #ctx: SessionContext;
  #options: OpenSessionOptions;
  #conn: AcpConnection;
  #normalizer: AcpNormalizer;
  #fs: FsPolicy;
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;
  #harnessTurn: ActiveHarnessTurn | undefined;
  #harnessSeq = 0;
  #onHarnessTurn: ((turn: HarnessTurnHandle) => void) | undefined;
  #onIdleActivity: ((event: NormalizedEvent) => void) | undefined;
  #approvals = new Map<string, PendingApproval>();
  #inputs = new Map<string, PendingInput>();
  #inputSeq = 0;
  /** agent→client requests being answered; close() lets cancelled answers reach the agent */
  #answering = new Set<Promise<unknown>>();
  #mode: OpenSessionOptions["mode"];
  #interaction: OpenSessionOptions["interaction"];
  #model: string | undefined;
  #effort: string | undefined;
  #pendingCommands: SlashCommandInfo[] | undefined;
  #pendingNotices: string[] = [];
  #announced = false;
  /** ACP has no system-prompt field: Tide's preamble rides along with the first prompt */
  #preamblePending = false;
  #turnActive = false;
  /** Number of unresolved `session/prompt` calls (initial `send` + mid-turn `steer`s) on the active turn. */
  #inflightPrompts = 0;
  #interrupted = false;
  #closed = false;

  constructor(child: ChildLike, options: OpenSessionOptions, ctx: SessionContext) {
    this.#ctx = ctx;
    this.#options = options;
    this.#mode = options.mode;
    this.#interaction = options.interaction;
    this.#model = options.model;
    this.#effort = options.effort;
    this.#fs = new FsPolicy(options.cwd, options.linkedDirs);
    this.#normalizer = new AcpNormalizer({
      onCommands: (commands) => {
        this.#pendingCommands = commands;
        ctx.onCommands?.(commands);
      },
      onModeChange: (modeId) => this.settings?.modeChanged(modeId),
      subagents: ctx.config.quirks?.subagents === true,
    });
    this.#conn = new AcpConnection(child, {
      label: ctx.label,
      log: (message) => ctx.env.log(message),
      onNotification: (method, params) => this.#notification(method, params),
      onRequest: (method, params) => this.#request(method, params),
      onExit: (error) => this.#died(error),
      ...(ctx.timers ? { timers: ctx.timers } : {}),
    });
  }

  get #quirks(): AcpQuirks | undefined {
    return this.#ctx.config.quirks;
  }

  #log(message: string): void {
    this.#ctx.env.log(`[acp:${this.#ctx.label}] ${message}`);
  }

  /** initialize → session/new | session/load → apply model/effort/mode. */
  async start(version = "0.0.0"): Promise<void> {
    const init = await this.#conn.request<AcpInitializeResult>("initialize", clientInitialize(version, this.#quirks), this.#ctx.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
    this.init = init;
    this.#ctx.onInitialized?.(init);
    const meta = systemPromptMeta(this.#quirks, this.#options.systemPromptAppend);
    const base = {
      cwd: this.#options.cwd,
      ...(meta ? { _meta: meta } : {}),
      mcpServers: toAcpMcpServers(this.#options.mcpServers),
      ...(init.agentCapabilities?.sessionCapabilities?.additionalDirectories && this.#options.linkedDirs?.length
        ? { additionalDirectories: this.#options.linkedDirs.map((dir) => dir.path) }
        : {}),
    };
    let result: AcpNewSessionResult;
    try {
      const loaded = this.#options.resume !== undefined ? await this.#load(init, base, this.#options.resume) : undefined;
      result = loaded ?? (await this.#conn.request<AcpNewSessionResult>("session/new", base));
    } catch (error) {
      if (isAuthRequired(error)) {
        const hint = authHint(this.#ctx.label, init);
        this.#ctx.onAuthRequired?.(hint);
        throw new AcpAuthRequiredError(hint);
      }
      throw error;
    }
    this.nativeSessionId = result.sessionId;
    if (this.#options.resume !== undefined && this.resumeFailed === undefined && this.#ctx.transcriptUsage) {
      await this.#ctx.transcriptUsage.baseline(result.sessionId).catch(() => undefined);
    }
    // a session that did not resume never saw the preamble either
    this.#preamblePending = meta === undefined && (this.#options.resume === undefined || this.resumeFailed !== undefined) && (this.#options.systemPromptAppend ?? "").trim() !== "";
    this.settings = new AcpSettings(this.#conn, result.sessionId, result, {
      label: this.#ctx.label,
      log: (message) => this.#log(message),
      defaultModel: this.#ctx.config.defaultModel,
      keepAgentMode: this.#quirks?.keepAgentMode === true,
      onNotice: (text) => this.#notice(text),
    });
    await this.settings.apply({ model: this.#options.model, effort: this.#options.effort, mode: this.#mode, interaction: this.#interaction });
  }

  /**
   * `session/load` the requested session. undefined when it could not be loaded (the agent has no
   * `loadSession`, or the load failed for another reason than auth): `start` then opens a new
   * session and `resumeFailed` says why, so the server can mark the lost history.
   */
  async #load(init: AcpInitializeResult, base: Record<string, unknown>, sessionId: string): Promise<AcpNewSessionResult | undefined> {
    // the resume method only where the agent offers it; an agent that offers just `loadSession` still reopens that way
    const resumable = init.agentCapabilities?.sessionCapabilities?.["resume"] !== undefined && init.agentCapabilities.sessionCapabilities["resume"] !== null;
    const method = this.#quirks?.resumeMethod === "resume" && resumable ? "session/resume" : "session/load";
    const supported = method === "session/resume" || init.agentCapabilities?.loadSession === true;
    if (!supported) {
      this.resumeFailed = `${this.#ctx.label} cannot load earlier sessions`;
      this.#log(`agent cannot load sessions; starting a new one instead of ${sessionId}`);
      return undefined;
    }
    this.#normalizer.muted = true;
    this.#normalizer.costBaselineUnknown = true;
    try {
      const loaded = await this.#conn.request<Omit<AcpNewSessionResult, "sessionId"> | null>(method, { ...base, sessionId });
      return { ...loaded, sessionId };
    } catch (error) {
      if (isAuthRequired(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.resumeFailed = `${this.#ctx.label} could not load session ${sessionId}: ${message}`;
      this.#log(`${method} failed (${message}); starting a new session`);
      this.#normalizer.costBaselineUnknown = false;
      return undefined;
    } finally {
      this.#normalizer.muted = false;
    }
  }

  get planSupported(): boolean {
    return this.settings?.planSupported ?? false;
  }

  onHarnessTurn(listener: (turn: HarnessTurnHandle) => void): void {
    this.#onHarnessTurn = listener;
  }

  onIdleActivity(listener: (event: NormalizedEvent) => void): void {
    this.#onIdleActivity = listener;
  }

  hasBackgroundWork(): boolean {
    return this.#harnessTurn !== undefined || this.#normalizer.hasActiveSwarmWorkers();
  }

  get #inTurn(): boolean {
    return this.#turnActive || this.#harnessTurn !== undefined;
  }

  /**
   * Opens a request-only harness turn for an unsolicited post-turn approval or question
   * (e.g. a background sub-agent or swarm prompt while no `send()` is active), matching
   * `driver-codex`. It settles as soon as its pending requests are answered — never on a
   * silence timer, which would chop normal thinking pauses into spurious `turn.settled`s.
   */
  #ensureRequestHarnessTurn(reason: string): boolean {
    if (this.#turnActive || this.#closed || this.#quirks?.harnessTurns !== true) return false;
    if (this.#harnessTurn !== undefined) return true;
    if (!this.#onHarnessTurn) return false;
    this.#harnessSeq += 1;
    const key = `acp-harness-${this.#harnessSeq}`;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#interrupted = false;
    const active: ActiveHarnessTurn = { key, mailbox };
    this.#harnessTurn = active;
    this.#mailbox = mailbox;
    this.#onHarnessTurn({
      key,
      reason,
      events: mailbox.drain(),
      dismiss: () => {
        if (this.#harnessTurn === active) this.#settleHarnessTurn("completed");
      },
    });
    return true;
  }

  #maybeSettleRequestHarnessTurn(): void {
    if (this.#harnessTurn === undefined) return;
    if (this.#approvals.size > 0 || this.#inputs.size > 0) return;
    this.#settleHarnessTurn("completed");
  }

  #settleHarnessTurn(status: "completed" | "interrupted" | "error", error?: string): void {
    const active = this.#harnessTurn;
    if (!active) return;
    this.#harnessTurn = undefined;
    if (this.#mailbox === active.mailbox) this.#mailbox = undefined;
    active.mailbox.push({ type: "settled", status, ...(error ? { error } : {}) });
    active.mailbox.close();
  }

  #emit(event: NormalizedEvent): void {
    if (this.#mailbox) {
      this.#mailbox.push(event);
    } else if (this.#quirks?.harnessTurns === true && event.type !== "commands" && event.type !== "session" && event.type !== "settled") {
      // Unsolicited post-turn updates (background sub-agents, swarm posts/tools) land live on the
      // thread's latest turn without opening/settling synthetic harness turns.
      this.#onIdleActivity?.(event);
    }
  }

  /** An info row now, or at the start of the next turn when none is running (open, reconfigure). */
  #notice(text: string): void {
    if (this.#mailbox) this.#emit({ type: "activity", activity: { kind: "info", text } });
    else this.#pendingNotices.push(text);
  }

  #notification(method: string, params: unknown): void {
    if (method !== "session/update") {
      this.#log(`unhandled notification ${method}`);
      return;
    }
    const { sessionId, update } = (params ?? {}) as { sessionId?: string; update?: AcpSessionUpdate };
    if (!update || typeof update.sessionUpdate !== "string") return;
    if (this.nativeSessionId !== undefined && sessionId !== undefined && sessionId !== this.nativeSessionId) return;
    if (update.sessionUpdate === "config_option_update") this.settings?.ingest({ configOptions: update["configOptions"] as never });
    for (const event of this.#normalizer.next(update)) {
      if (event.type === "usage" && event.contextUsage !== undefined) this.#ctx.onContextUsage?.();
      if (event.type === "commands") {
        if (!this.#inTurn) continue; // flushed at the start of the next turn
        this.#pendingCommands = undefined;
      }
      this.#emit(event);
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const work = this.#answer(method, params);
    this.#answering.add(work);
    const done = (): void => {
      this.#answering.delete(work);
    };
    void work.then(done, done);
    return work;
  }

  async #answer(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.#permission(params as AcpPermissionRequest);
      case "session/request_user_input":
        // not in ACP v1; accepted early so an agent that ships it still reaches the user
        return this.#userInput(params as AcpUserInputRequest);
      case "elicitation/create":
        return this.#elicitation(params);
      case "fs/read_text_file":
        return this.#fs.read(params);
      case "fs/write_text_file":
        return this.#fs.write(params);
      default:
        // `terminal/*` included: Tide advertises `terminal: false`
        throw rpcError(ACP_ERROR.methodNotFound, `Tide does not implement ${method}`);
    }
  }

  async #permission(request: AcpPermissionRequest): Promise<unknown> {
    const cancelled = { outcome: { outcome: "cancelled" } };
    const call = request?.toolCall;
    if (!call || !Array.isArray(request.options) || this.#interrupted) return cancelled;
    const known = this.#normalizer.tool(call.toolCallId);
    const merged = { ...known, ...Object.fromEntries(Object.entries(call).filter(([, value]) => value !== undefined && value !== null)), toolCallId: call.toolCallId };
    if (isQuestionOptions(request.options)) {
      if (!this.#inTurn && !this.#ensureRequestHarnessTurn(`${this.#ctx.label} asks a question`)) return cancelled;
      // a question, never auto-answered by the runtime mode
      const requestId = this.#uniqueId(call.toolCallId);
      const question = permissionQuestion(requestId, merged.title ?? toolName(merged), request.options);
      const optionId = answerOption(request.options, question.id, await this.#ask(requestId, [question]));
      this.#maybeSettleRequestHarnessTurn();
      return optionId === undefined ? cancelled : { outcome: { outcome: "selected", optionId } };
    }
    const plan = planPermission(this.#mode, merged.kind, request.options);
    if (plan.kind === "auto") {
      if (!this.#inTurn && this.#quirks?.harnessTurns !== true) return cancelled;
      if (plan.audit) this.#emit({ type: "activity", activity: { kind: "info", text: `auto-approved: ${merged.title ?? toolName(merged)}` } });
      return { outcome: { outcome: "selected", optionId: plan.optionId } };
    }
    if (!this.#inTurn && !this.#ensureRequestHarnessTurn(`${this.#ctx.label} needs approval`)) return cancelled;
    const requestId = this.#uniqueId(call.toolCallId);
    const answer = deferred<string | undefined>();
    this.#approvals.set(requestId, { options: request.options, answer });
    const diff = toolDiff(merged.content);
    this.#emit({
      type: "activity",
      activity: {
        kind: "approval",
        requestId,
        toolName: toolName(merged),
        input: toolInput(merged),
        status: "pending",
        ...(merged.title ? { title: merged.title } : {}),
        ...(diff ? { diff } : {}),
      },
    });
    const optionId = await answer.promise;
    this.#approvals.delete(requestId);
    this.#maybeSettleRequestHarnessTurn();
    return optionId === undefined ? cancelled : { outcome: { outcome: "selected", optionId } };
  }

  async #userInput(request: AcpUserInputRequest): Promise<unknown> {
    const questions = userInputQuestions(request);
    if (questions.length === 0 || this.#interrupted) return { outcome: { outcome: "cancelled" } };
    if (!this.#inTurn && !this.#ensureRequestHarnessTurn(`${this.#ctx.label} asks a question`)) return { outcome: { outcome: "cancelled" } };
    this.#inputSeq += 1;
    const result = userInputResult(questions, await this.#ask(this.#uniqueId(`input-${this.#inputSeq}`), questions));
    this.#maybeSettleRequestHarnessTurn();
    return result;
  }

  /** ACP `elicitation/create` (form mode) → a question card; answered `{action, content}`. */
  async #elicitation(params: unknown): Promise<unknown> {
    const cancel = { action: "cancel" };
    const request = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const form = elicitationForm(request);
    // nothing renderable (or a URL flow): decline, and the agent asks in the chat instead
    if (form === undefined) return { action: "decline" };
    if (this.#interrupted) return cancel;
    if (!this.#inTurn && !this.#ensureRequestHarnessTurn(`${this.#ctx.label} asks a question`)) return cancel;
    const base = typeof request["toolCallId"] === "string" && request["toolCallId"] !== "" ? request["toolCallId"] : `elicitation-${++this.#inputSeq}`;
    const answers = await this.#ask(this.#uniqueId(base), form.questions);
    this.#maybeSettleRequestHarnessTurn();
    const content = answers === undefined ? undefined : form.toContent(answers);
    return content === undefined ? cancel : { action: "accept", content };
  }

  /** Emit a `user-input` activity and wait for `respondUserInput` (undefined = cancelled). */
  async #ask(requestId: string, questions: UserInputQuestion[]): Promise<Record<string, unknown> | undefined> {
    const answer = deferred<Record<string, unknown> | undefined>();
    this.#inputs.set(requestId, { answer });
    this.#emit({ type: "activity", activity: { kind: "user-input", requestId, questions, status: "pending" } });
    try {
      return await answer.promise;
    } finally {
      this.#inputs.delete(requestId);
    }
  }

  #uniqueId(base: string): string {
    let requestId = base;
    for (let n = 2; this.#approvals.has(requestId) || this.#inputs.has(requestId); n += 1) requestId = `${base}#${n}`;
    return requestId;
  }

  /** Every unanswered permission or question is answered `cancelled`. */
  #cancelApprovals(): void {
    for (const pending of this.#approvals.values()) pending.answer.resolve(undefined);
    this.#approvals.clear();
    for (const pending of this.#inputs.values()) pending.answer.resolve(undefined);
    this.#inputs.clear();
  }

  #died(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelApprovals();
    for (const event of this.#normalizer.closeRunningWorkers(`${this.#ctx.label} exited`)) this.#onIdleActivity?.(event);
    if (this.#harnessTurn) {
      this.#settleHarnessTurn(this.#interrupted ? "interrupted" : "error", error.message);
      return;
    }
    this.#mailbox?.push({ type: "settled", status: this.#interrupted ? "interrupted" : "error", error: error.message });
    this.#mailbox?.close();
  }

  #prompt(input: TurnInput): unknown[] {
    const blocks: unknown[] = [];
    // Defer `<tide-context>` on a turn-1 leading slash command so the agent sees `/cmd` verbatim.
    const isSlashCommand = /^\s*\/[^\s/]+(?:\s|$)/.test(input.text);
    if (this.#preamblePending && !isSlashCommand) {
      this.#preamblePending = false;
      blocks.push({ type: "text", text: `<tide-context>\n${this.#options.systemPromptAppend ?? ""}\n</tide-context>` });
    }
    if (input.text !== "") blocks.push({ type: "text", text: input.text });
    const images = input.images ?? [];
    if (images.length > 0) {
      if (this.init?.agentCapabilities?.promptCapabilities?.image) {
        for (const image of images) blocks.push({ type: "image", data: image.data, mimeType: image.mediaType });
      } else {
        const count = images.length === 1 ? "1 image" : `${images.length} images`;
        this.#emit({ type: "activity", activity: { kind: "info", text: `${count} dropped: ${this.#ctx.label} does not accept images` } });
      }
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    return blocks;
  }

  /**
   * Turn usage: `PromptResponse.usage` (unstable ACP field; OpenCode 2.x reports the turn's own
   * tokens there) plus the turn's share of the cumulative `usage_update.cost`.
   */
  #turnUsage(usage: AcpPromptUsage | undefined, fallback?: TurnUsage): NormalizedEvent[] {
    const cost = this.#normalizer.turnCost;
    const tokens = usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number" ? usage : undefined;
    if (!tokens && !fallback && cost <= 0) return [];
    if (!tokens && fallback) {
      return [
        {
          type: "usage",
          usage: {
            ...fallback,
            ...(cost > 0 ? { costUsd: cost } : {}),
          },
        },
      ];
    }
    // Reasoning/thought tokens are billed as output, matching Codex and OpenCode (docs/internals/usage.md).
    const thought = typeof tokens?.thoughtTokens === "number" && tokens.thoughtTokens > 0 ? tokens.thoughtTokens : 0;
    return [
      {
        type: "usage",
        usage: {
          inputTokens: tokens?.inputTokens ?? 0,
          outputTokens: (tokens?.outputTokens ?? 0) + thought,
          ...(typeof tokens?.cachedReadTokens === "number" ? { cacheReadTokens: tokens.cachedReadTokens } : {}),
          ...(typeof tokens?.cachedWriteTokens === "number" ? { cacheWriteTokens: tokens.cachedWriteTokens } : {}),
          ...(cost > 0 ? { costUsd: cost } : {}),
        },
      },
    ];
  }

  #settle(result: { stopReason?: AcpStopReason | string; usage?: AcpPromptUsage } | null | undefined, fallbackUsage?: TurnUsage): NormalizedEvent[] {
    const stopReason = result?.stopReason;
    const events: NormalizedEvent[] = this.#turnUsage(result?.usage, fallbackUsage);
    if (this.#interrupted || stopReason === "cancelled") return [...events, { type: "settled", status: "interrupted" }];
    if (stopReason === "refusal") return [...events, { type: "settled", status: "error", error: `${this.#ctx.label} refused to continue` }];
    if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      events.push({ type: "activity", activity: { kind: "info", text: `Stopped: ${stopReason.replaceAll("_", " ")}` } });
    }
    if (this.#interaction === "plan" && this.planSupported) {
      const markdown = this.#normalizer.lastText();
      if (markdown !== undefined) events.push({ type: "plan.proposed", markdown });
    }
    events.push({ type: "settled", status: "completed" });
    return events;
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error(`${this.#ctx.label} session is closed`);
    if (this.#turnActive) throw new Error(`busy: a turn is already running on this ${this.#ctx.label} session`);
    const sessionId = this.nativeSessionId;
    if (sessionId === undefined) throw new Error(`${this.#ctx.label} session is not started`);
    if (this.#harnessTurn !== undefined) this.#settleHarnessTurn("completed");
    this.#turnActive = true;
    this.#inflightPrompts = 1;
    this.#interrupted = false;
    this.#normalizer.beginTurn();
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    if (!this.#announced) {
      this.#announced = true;
      const model = this.settings?.currentModel;
      mailbox.push({ type: "session", nativeSessionId: sessionId, ...(model ? { model } : {}) });
    }
    if (this.#pendingCommands) {
      mailbox.push({ type: "commands", commands: this.#pendingCommands });
      this.#pendingCommands = undefined;
    }
    for (const text of this.#pendingNotices.splice(0)) mailbox.push({ type: "activity", activity: { kind: "info", text } });
    const prompt = this.#prompt(input);
    this.#conn
      .request<{ stopReason?: AcpStopReason; usage?: AcpPromptUsage } | null>("session/prompt", { sessionId, prompt })
      .then(
        (result) => this.#onPromptResolved(sessionId, mailbox, result),
        (error: unknown) => this.#onPromptRejected(mailbox, error, false),
      );

    const self = this;
    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      try {
        for await (const event of mailbox.drain()) yield event;
      } finally {
        self.#turnActive = false;
        self.#inflightPrompts = 0;
        self.#mailbox = undefined;
        self.#cancelApprovals();
      }
    }
    return stream();
  }

  /**
   * Handles a `session/prompt` resolution (either the original `send` or a mid-turn `steer`).
   * Antigravity can resolve the original `session/prompt` early when a steer arrives and keep
   * streaming tool calls, plan updates, and the final reply under the steer's `session/prompt`.
   * Only settle and close the turn mailbox once EVERY in-flight `session/prompt` has finished.
   */
  async #onPromptResolved(
    sessionId: string,
    mailbox: AsyncQueue<NormalizedEvent>,
    result: { stopReason?: AcpStopReason; usage?: AcpPromptUsage } | null | undefined,
  ): Promise<void> {
    if (this.#mailbox !== mailbox) return;
    this.#inflightPrompts = Math.max(0, this.#inflightPrompts - 1);
    if (this.#inflightPrompts > 0) {
      // Another `session/prompt` (e.g. a steer continuation) is still driving this turn: keep the
      // mailbox open and only flush wire usage reported by this earlier response.
      for (const event of this.#turnUsage(result?.usage)) mailbox.push(event);
      return;
    }
    const hasWireUsage = result?.usage !== undefined && typeof result.usage.inputTokens === "number" && typeof result.usage.outputTokens === "number";
    const fallbackUsage = !hasWireUsage && this.#ctx.transcriptUsage ? await this.#ctx.transcriptUsage.delta(sessionId).catch(() => undefined) : undefined;
    if (this.#mailbox !== mailbox || this.#inflightPrompts > 0) return;
    for (const event of this.#settle(result, fallbackUsage)) mailbox.push(event);
    mailbox.close();
  }

  /** Handles a `session/prompt` rejection; returns true if the caller (`steer`) should rethrow for fallback. */
  #onPromptRejected(mailbox: AsyncQueue<NormalizedEvent>, error: unknown, isSteer: boolean): boolean {
    if (this.#mailbox !== mailbox) return false;
    this.#inflightPrompts = Math.max(0, this.#inflightPrompts - 1);
    if (isAuthRequired(error)) this.#ctx.onAuthRequired?.(authHint(this.#ctx.label, this.init));
    if (isSteer && this.#inflightPrompts > 0) {
      // The steer was refused while the primary prompt is still running: leave the turn alive
      // and let `steer()` reject so the reactor falls back to queueing the message.
      return true;
    }
    if (this.#inflightPrompts > 0) return false;
    const message = error instanceof Error ? error.message : String(error);
    mailbox.push({ type: "settled", status: this.#interrupted ? "interrupted" : "error", error: message });
    mailbox.close();
    return false;
  }

  /**
   * Steers a running turn by sending another `session/prompt` mid-turn (Antigravity 1.5.0+).
   * Rejects when no turn is active or when the target harness turn already ended.
   */
  async steer(input: TurnInput, target?: SteerTarget): Promise<void> {
    if (this.#closed) throw new Error(`${this.#ctx.label} session is closed`);
    if (this.#quirks?.steerByPrompt !== true) throw new Error(`${this.#ctx.label} does not support steering`);
    const sessionId = this.nativeSessionId;
    if (sessionId === undefined) throw new Error(`${this.#ctx.label} session is not started`);
    if (!this.#inTurn) throw new Error(`no turn is running on this ${this.#ctx.label} session`);
    if (target?.turnKey !== undefined && target.turnKey !== this.#harnessTurn?.key) {
      throw new Error(`conflict: harness turn ${target.turnKey} is no longer running`);
    }
    const prompt = this.#prompt(input);
    const mailbox = this.#mailbox;
    const attachedToTurn = this.#turnActive && mailbox !== undefined;
    if (attachedToTurn) this.#inflightPrompts += 1;
    try {
      const result = await this.#conn.request<{ stopReason?: AcpStopReason; usage?: AcpPromptUsage } | null>("session/prompt", { sessionId, prompt });
      if (attachedToTurn) await this.#onPromptResolved(sessionId, mailbox, result);
    } catch (error) {
      // If the session closed after the steer was already sent, do not falsely trigger steer.fallback.
      if (this.#closed) return;
      if (attachedToTurn) {
        const shouldRethrow = this.#onPromptRejected(mailbox, error, true);
        if (!shouldRethrow) return;
      }
      throw error;
    }
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.#approvals.get(requestId);
    if (!pending) return;
    pending.answer.resolve(decisionOption(decision, pending.options));
  }

  /** Answers a question-shaped `session/request_permission` or a `session/request_user_input`. */
  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    this.#inputs.get(requestId)?.answer.resolve(answers);
  }

  /** `session/cancel` is a notification; pending permission requests MUST be answered `cancelled`. */
  async interrupt(): Promise<void> {
    if (!this.#inTurn || this.nativeSessionId === undefined) return;
    this.#interrupted = true;
    this.#conn.notify("session/cancel", { sessionId: this.nativeSessionId });
    this.#cancelApprovals();
    if (this.#harnessTurn !== undefined) this.#settleHarnessTurn("interrupted");
  }

  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    if (this.#closed || !this.settings) return "reopen";
    if (this.#inTurn) {
      // Mid-turn: a runtime-mode change applies immediately to every incoming permission request
      // (and to the agent mode when not `keepAgentMode`); model/effort/interaction still wait for idle.
      if (settings.model !== this.#model || settings.effort !== this.#effort || settings.interaction !== this.#interaction) {
        return "reopen";
      }
      this.#mode = settings.mode;
      const ok = await this.settings.applyMode(settings.mode, settings.interaction);
      return ok ? "applied" : "reopen";
    }
    this.#mode = settings.mode;
    this.#interaction = settings.interaction;
    this.#model = settings.model;
    this.#effort = settings.effort;
    const ok = await this.settings.apply({ model: settings.model, effort: settings.effort, mode: settings.mode, interaction: settings.interaction });
    return ok ? "applied" : "reopen";
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelApprovals();
    for (const event of this.#normalizer.closeRunningWorkers("Session ended")) this.#onIdleActivity?.(event);
    if (this.#harnessTurn !== undefined) this.#settleHarnessTurn("interrupted");
    else if (this.#turnActive) this.#mailbox?.push({ type: "settled", status: "interrupted" });
    this.#mailbox?.close();
    // the agent gets its `cancelled` answers before the process is stopped
    await Promise.allSettled([...this.#answering]);
    // let agents advertising `sessionCapabilities.close` cleanly tear down MCP servers and flush state
    const canClose = this.init?.agentCapabilities?.sessionCapabilities?.["close"] !== undefined && this.init.agentCapabilities.sessionCapabilities["close"] !== null;
    if (canClose && this.nativeSessionId !== undefined && !this.#conn.dead) {
      await this.#conn.request("session/close", { sessionId: this.nativeSessionId }, 1_500).catch(() => undefined);
    }
    this.#conn.close();
  }
}
