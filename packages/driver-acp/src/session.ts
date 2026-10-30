import type { ApprovalDecision, DriverEnv, NormalizedEvent, OpenSessionOptions, ProviderSession, ReconfigureResult, SessionSettings, SlashCommandInfo, TurnInput } from "@tide/contracts";
import { AsyncQueue, deferred, type Deferred } from "./async-queue.ts";
import { FsPolicy } from "./fs.ts";
import { AcpConnection, RpcError, rpcError } from "./jsonrpc.ts";
import { AcpNormalizer, toolDiff, toolInput, toolName } from "./normalize.ts";
import { decisionOption, planPermission } from "./permissions.ts";
import { AcpSettings } from "./settings.ts";
import { toAcpMcpServers } from "./spawn.ts";
import {
  ACP_ERROR,
  type AcpConfig,
  type AcpInitializeResult,
  type AcpNewSessionResult,
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

export function clientInitialize(version: string): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
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
}

export class AcpSession implements ProviderSession {
  nativeSessionId: string | undefined;
  init: AcpInitializeResult | undefined;
  settings: AcpSettings | undefined;

  #ctx: SessionContext;
  #options: OpenSessionOptions;
  #conn: AcpConnection;
  #normalizer: AcpNormalizer;
  #fs: FsPolicy;
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;
  #approvals = new Map<string, PendingApproval>();
  #mode: OpenSessionOptions["mode"];
  #interaction: OpenSessionOptions["interaction"];
  #pendingCommands: SlashCommandInfo[] | undefined;
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

  #log(message: string): void {
    this.#ctx.env.log(`[acp:${this.#ctx.label}] ${message}`);
  }

  /** initialize → session/new | session/load → apply model/effort/mode. */
  async start(version = "0.0.0"): Promise<void> {
    const init = await this.#conn.request<AcpInitializeResult>("initialize", clientInitialize(version), this.#ctx.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
    this.init = init;
    this.#ctx.onInitialized?.(init);
    const base = {
      cwd: this.#options.cwd,
      mcpServers: toAcpMcpServers(this.#options.mcpServers),
      ...(init.agentCapabilities?.sessionCapabilities?.additionalDirectories && this.#options.linkedDirs?.length
        ? { additionalDirectories: this.#options.linkedDirs.map((dir) => dir.path) }
        : {}),
    };
    let result: AcpNewSessionResult;
    try {
      if (this.#options.resume && init.agentCapabilities?.loadSession) {
        this.#normalizer.muted = true;
        this.#normalizer.costBaselineUnknown = true;
        try {
          const loaded = await this.#conn.request<Omit<AcpNewSessionResult, "sessionId"> | null>("session/load", { ...base, sessionId: this.#options.resume });
          result = { ...loaded, sessionId: this.#options.resume };
        } finally {
          this.#normalizer.muted = false;
        }
      } else {
        if (this.#options.resume) this.#log(`agent cannot load sessions; starting a new one instead of ${this.#options.resume}`);
        result = await this.#conn.request<AcpNewSessionResult>("session/new", base);
      }
    } catch (error) {
      if (isAuthRequired(error)) {
        const hint = authHint(this.#ctx.label, init);
        this.#ctx.onAuthRequired?.(hint);
        throw new AcpAuthRequiredError(hint);
      }
      throw error;
    }
    this.nativeSessionId = result.sessionId;
    this.#preamblePending = !this.#options.resume && (this.#options.systemPromptAppend ?? "").trim() !== "";
    this.settings = new AcpSettings(this.#conn, result.sessionId, result, (message) => this.#log(message), this.#ctx.config.defaultModel);
    await this.settings.apply({ model: this.#options.model, effort: this.#options.effort, mode: this.#mode, interaction: this.#interaction });
  }

  get planSupported(): boolean {
    return this.settings?.planSupported ?? false;
  }

  #emit(event: NormalizedEvent): void {
    this.#mailbox?.push(event);
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
      if (event.type === "commands") {
        if (!this.#turnActive) continue; // flushed at the start of the next turn
        this.#pendingCommands = undefined;
      }
      this.#emit(event);
    }
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.#permission(params as AcpPermissionRequest);
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
    const plan = planPermission(this.#mode, merged.kind, request.options);
    if (plan.kind === "auto") {
      if (plan.audit) this.#emit({ type: "activity", activity: { kind: "info", text: `auto-approved: ${merged.title ?? toolName(merged)}` } });
      return { outcome: { outcome: "selected", optionId: plan.optionId } };
    }
    let requestId = call.toolCallId;
    for (let n = 2; this.#approvals.has(requestId); n += 1) requestId = `${call.toolCallId}#${n}`;
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

  #cancelApprovals(): void {
    for (const pending of this.#approvals.values()) pending.answer.resolve(undefined);
    this.#approvals.clear();
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

  /** ACP v1 has no free-form user-input requests (elicitation is unstable); nothing to answer. */
  async respondUserInput(_requestId: string, _answers: Record<string, unknown>): Promise<void> {}

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
    this.#conn.close();
  }
}
