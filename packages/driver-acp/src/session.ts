import type { ApprovalDecision, DriverEnv, NormalizedEvent, OpenSessionOptions, ProviderSession, ReconfigureResult, SessionSettings, SlashCommandInfo, TurnInput } from "@tide/contracts";
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

export function clientInitialize(version: string, quirks?: AcpQuirks): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: quirks?.advertiseFsWrite !== false }, terminal: false },
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
  #approvals = new Map<string, PendingApproval>();
  #inputs = new Map<string, PendingInput>();
  #inputSeq = 0;
  /** agent→client requests being answered; close() lets cancelled answers reach the agent */
  #answering = new Set<Promise<unknown>>();
  #mode: OpenSessionOptions["mode"];
  #interaction: OpenSessionOptions["interaction"];
  #pendingCommands: SlashCommandInfo[] | undefined;
  #pendingNotices: string[] = [];
  #announced = false;
  /** ACP has no system-prompt field: Tide's preamble rides along with the first prompt */
  #preamblePending = false;
  #turnActive = false;
  #interrupted = false;
  #closed = false;

  constructor(child: ChildLike, options: OpenSessionOptions, ctx: SessionContext) {
    this.#ctx = ctx;
    this.#options = options;
    this.#mode = options.mode;
    this.#interaction = options.interaction;
    this.#fs = new FsPolicy(options.cwd, options.linkedDirs);
    this.#normalizer = new AcpNormalizer({
      onCommands: (commands) => {
        this.#pendingCommands = commands;
        ctx.onCommands?.(commands);
      },
      onModeChange: (modeId) => this.settings?.modeChanged(modeId),
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

  #emit(event: NormalizedEvent): void {
    this.#mailbox?.push(event);
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
        if (!this.#turnActive) continue; // flushed at the start of the next turn
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
    if (!call || !Array.isArray(request.options) || !this.#turnActive || this.#interrupted) return cancelled;
    const known = this.#normalizer.tool(call.toolCallId);
    const merged = { ...known, ...Object.fromEntries(Object.entries(call).filter(([, value]) => value !== undefined && value !== null)), toolCallId: call.toolCallId };
    if (isQuestionOptions(request.options)) {
      // a question, never auto-answered by the runtime mode
      const requestId = this.#uniqueId(call.toolCallId);
      const question = permissionQuestion(requestId, merged.title ?? toolName(merged), request.options);
      const optionId = answerOption(request.options, question.id, await this.#ask(requestId, [question]));
      return optionId === undefined ? cancelled : { outcome: { outcome: "selected", optionId } };
    }
    const plan = planPermission(this.#mode, merged.kind, request.options);
    if (plan.kind === "auto") {
      if (plan.audit) this.#emit({ type: "activity", activity: { kind: "info", text: `auto-approved: ${merged.title ?? toolName(merged)}` } });
      return { outcome: { outcome: "selected", optionId: plan.optionId } };
    }
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
    return optionId === undefined ? cancelled : { outcome: { outcome: "selected", optionId } };
  }

  async #userInput(request: AcpUserInputRequest): Promise<unknown> {
    const questions = userInputQuestions(request);
    if (questions.length === 0 || !this.#turnActive || this.#interrupted) return { outcome: { outcome: "cancelled" } };
    this.#inputSeq += 1;
    return userInputResult(questions, await this.#ask(this.#uniqueId(`input-${this.#inputSeq}`), questions));
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
    this.#mailbox?.push({ type: "settled", status: this.#interrupted ? "interrupted" : "error", error: error.message });
    this.#mailbox?.close();
  }

  #prompt(input: TurnInput): unknown[] {
    const blocks: unknown[] = [];
    if (this.#preamblePending) {
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
  #turnUsage(usage: AcpPromptUsage | undefined): NormalizedEvent[] {
    const cost = this.#normalizer.turnCost;
    const tokens = usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number" ? usage : undefined;
    if (!tokens && cost <= 0) return [];
    return [
      {
        type: "usage",
        usage: {
          inputTokens: tokens?.inputTokens ?? 0,
          outputTokens: tokens?.outputTokens ?? 0,
          ...(typeof tokens?.cachedReadTokens === "number" ? { cacheReadTokens: tokens.cachedReadTokens } : {}),
          ...(typeof tokens?.cachedWriteTokens === "number" ? { cacheWriteTokens: tokens.cachedWriteTokens } : {}),
          ...(cost > 0 ? { costUsd: cost } : {}),
        },
      },
    ];
  }

  #settle(result: { stopReason?: AcpStopReason | string; usage?: AcpPromptUsage } | null | undefined): NormalizedEvent[] {
    const stopReason = result?.stopReason;
    const events: NormalizedEvent[] = this.#turnUsage(result?.usage);
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
    this.#turnActive = true;
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
    const finish = (events: NormalizedEvent[]): void => {
      for (const event of events) mailbox.push(event);
      mailbox.close();
    };
    this.#conn
      .request<{ stopReason?: AcpStopReason; usage?: AcpPromptUsage } | null>("session/prompt", { sessionId, prompt })
      .then((result) => finish(this.#settle(result)))
      .catch((error: unknown) => {
        if (isAuthRequired(error)) this.#ctx.onAuthRequired?.(authHint(this.#ctx.label, this.init));
        const message = error instanceof Error ? error.message : String(error);
        finish([{ type: "settled", status: this.#interrupted ? "interrupted" : "error", error: message }]);
      });

    const self = this;
    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      try {
        for await (const event of mailbox.drain()) yield event;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
        self.#cancelApprovals();
      }
    }
    return stream();
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
    if (!this.#turnActive || this.nativeSessionId === undefined) return;
    this.#interrupted = true;
    this.#conn.notify("session/cancel", { sessionId: this.nativeSessionId });
    this.#cancelApprovals();
  }

  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    if (this.#closed || this.#turnActive || !this.settings) return "reopen";
    this.#mode = settings.mode;
    this.#interaction = settings.interaction;
    const ok = await this.settings.apply({ model: settings.model, effort: settings.effort, mode: settings.mode, interaction: settings.interaction });
    return ok ? "applied" : "reopen";
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelApprovals();
    if (this.#turnActive) this.#mailbox?.push({ type: "settled", status: "interrupted" });
    this.#mailbox?.close();
    // the agent gets its `cancelled` answers before the process is stopped
    await Promise.allSettled([...this.#answering]);
    this.#conn.close();
  }
}
