import { randomUUID } from "node:crypto";
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
import { ApprovalBroker, type CanUseToolContext, type PermissionResultShape } from "./approvals.ts";
import { AsyncQueue } from "./async-queue.ts";
import { instanceEnv } from "./env.ts";
import { CONTINUED_REASON, HarnessTurn, type HarnessTurnListener, isIdleActivity, isSubstantive, Preamble, reportedReason } from "./harness-turn.ts";
import { ClaudeNormalizer } from "./normalize.ts";
import { rollbackPoint } from "./rollback.ts";
import type { ClaudeMessage, ResultMessage, TranscriptEntry } from "./sdk-shapes.ts";
import type { ClaudeConfig, QueryFn, QueryLike, SessionMessagesFn } from "./types.ts";

/**
 * Streaming-input mode: one `query()` per session, fed by an async iterable we push user
 * messages into, so every turn of a thread runs in the same CLI process.
 *
 * Chosen over "one `query()` per turn with `resume`" because the whole Query control plane
 * — `interrupt()`, `setPermissionMode()`, `getContextUsage()`, `supportedModels()` — is
 * documented as streaming-input-only, and because respawning the CLI per turn re-launches
 * every MCP server and re-reads the transcript on each send. The cost is that `send()` is
 * strictly one turn at a time (see the `busy` guard below).
 *
 * R4 on top of that query:
 * - steer: a user message pushed into the same input stream while a turn runs. The CLI
 *   queues it and folds it into the running turn between tool rounds (no tool is
 *   interrupted); the turn's `result` lists it in `user_message_uuids`. If the turn ended
 *   before the fold, `queued_turn_count > 0` says another turn follows for it, and the Tide
 *   turn keeps streaming until that next `result` — one `send()` settles exactly once.
 * - fork: `resume: <source>` + `forkSession: true` on the next query mints a new session id.
 * - rollback: a truncating resume (`resume` + `resumeSessionAt: <kept turn's last chain
 *   entry>`) on a fresh query; the uuid comes from the transcript (`getSessionMessages`).
 *
 * R14 idle pump and harness turns: Claude Code does not stop at a `result`. When the model
 * launched background sub-agents (Agent tool, "Async agent launched successfully"), the CLI
 * later injects a `<task-notification>` user message and runs a new model turn by itself —
 * text, tools, even an `AskUserQuestion` through `canUseTool` — ending in its own `result`.
 * So once a send settles, `#idleLoop` keeps reading the same iterator. Bookkeeping read while
 * idle (session ids, usage, rate limits, child progress, `info` rows) is held in a small
 * preamble; the first substantive event (see `isSubstantive`), a `<task-notification>` user
 * message, or a broker emit opens a *harness turn*: its own mailbox handed to the
 * `onHarnessTurn` listener, ended by the next `result`. A `send()` arriving meanwhile waits
 * for that turn to settle, then takes the iterator over (the in-flight `next()` is shared
 * through `#read`, so a read the idle loop started is consumed by the send's pump instead).
 * A background sub-agent's own progress (its tool calls, its child row while running) is not
 * held: it goes live to the `onIdleActivity` listener, which lands it on the sub-agent's row.
 */

/** A background sub-agent's final row when the CLI process that ran it ended before it reported. */
export const LOST_BACKGROUND_SUMMARY = "No report: the Claude Code session ended before this sub-agent finished";

async function sdkSessionMessages(): Promise<SessionMessagesFn> {
  const module: unknown = await import("@anthropic-ai/claude-agent-sdk");
  const { getSessionMessages } = module as { getSessionMessages: SessionMessagesFn };
  return getSessionMessages;
}

export const MODE_TO_PERMISSION: Record<string, string> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
};

interface UserMessageEnvelope {
  type: "user";
  message: { role: "user"; content: string | Record<string, unknown>[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid: string;
}

function buildUserMessage(input: TurnInput, sessionId: string): UserMessageEnvelope {
  const images = input.images ?? [];
  const content =
    images.length === 0
      ? input.text
      : [
          ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
          { type: "text", text: input.text },
        ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() };
}

export class ClaudeSession implements ProviderSession {
  nativeSessionId: string | undefined;

  #config: ClaudeConfig;
  #env: DriverEnv;
  #options: OpenSessionOptions;
  #queryFn: QueryFn;
  #binaryPath: string | undefined;

  #broker: ApprovalBroker;
  #normalizer: ClaudeNormalizer;
  #inbox = new AsyncQueue<UserMessageEnvelope>();
  #abort = new AbortController();
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;

  #query: QueryLike | undefined;
  #sessionMessages: SessionMessagesFn | undefined;
  #iterator: AsyncIterator<ClaudeMessage> | undefined;
  #permissionMode: string;
  #autoModeFallbackAvailable: boolean;
  #started = false;
  #turnActive = false;
  #closed = false;
  #interruptRequested = false;

  /** fork source, consumed once the forked session reports its own id */
  #forkFrom: string | undefined;
  /** pending truncating resume (rollback), consumed with the next query's `system/init` */
  #resumeAt: string | undefined;
  /** uuids of this session's `send()` prompts, oldest first */
  #prompts: string[] = [];
  /** uuids of every message steered by this session */
  #steers = new Set<string>();
  /** messages of the running turn (prompt first, then steers), re-pushed if the query is rebuilt */
  #turnMessages: UserMessageEnvelope[] = [];
  /** steers of the running turn the CLI has not reported consuming yet */
  #pendingSteers = new Set<string>();
  /** true once the running turn's messages are in the input stream */
  #turnFed = false;

  #harnessListener: HarnessTurnListener | undefined;
  #idleActivityListener: ((event: NormalizedEvent) => void) | undefined;
  /** the turn Claude Code is running on its own, if any */
  #harness: HarnessTurn | undefined;
  #preamble = new Preamble();
  /** bumped to stop the idle loop (a send takes over, reset, close) */
  #idleGen = 0;
  /** the pending `next()` on the live iterator, shared by whichever reader owns it next */
  #inflight: { iterator: AsyncIterator<ClaudeMessage>; promise: Promise<IteratorResult<ClaudeMessage>> } | undefined;
  #warnedNoListener = false;

  constructor(config: ClaudeConfig, env: DriverEnv, options: OpenSessionOptions, queryFn: QueryFn, binaryPath?: string) {
    this.#config = config;
    this.#env = env;
    this.#options = options;
    this.#queryFn = queryFn;
    if (binaryPath !== undefined) this.#binaryPath = binaryPath;
    if (options.resume !== undefined && options.forkFrom !== undefined) throw new Error("invalid-params: resume and forkFrom are mutually exclusive");
    if (options.resume !== undefined) this.nativeSessionId = options.resume;
    if (options.forkFrom !== undefined) this.#forkFrom = options.forkFrom;
    this.#permissionMode = options.interaction === "plan" ? "plan" : (MODE_TO_PERMISSION[options.mode] ?? "default");
    this.#autoModeFallbackAvailable = this.#permissionMode === "auto";
    this.#broker = new ApprovalBroker((event) => this.#emit(event), options.linkedDirs ?? []);
    this.#normalizer = this.#newNormalizer();
  }

  #newNormalizer(): ClaudeNormalizer {
    const env = this.#env;
    return new ClaudeNormalizer({
      partialMessages: true,
      // the frame itself is passed through to the timeline; this is just driver-debug noise
      onUnknown: (type, subtype) => {
        if (process.env["TIDE_DEBUG_CLAUDE"]) env.log(`[claude] unhandled message ${type}${subtype ? `/${subtype}` : ""}`);
      },
    });
  }

  /** Broker/driver events: the running send, else the harness turn, else a new harness turn. */
  #emit(event: NormalizedEvent): void {
    if (this.#mailbox) {
      this.#mailbox.push(event);
      return;
    }
    if (this.#closed) return;
    const reason = event.type === "activity" && event.activity.kind === "user-input" ? "Claude Code asked a question" : CONTINUED_REASON;
    (this.#harness ?? this.#openHarness(reason)).push(event);
  }

  onHarnessTurn(listener: HarnessTurnListener): void {
    this.#harnessListener = listener;
  }

  onIdleActivity(listener: (event: NormalizedEvent) => void): void {
    this.#idleActivityListener = listener;
  }

  hasBackgroundWork(): boolean {
    return this.#harness !== undefined || this.#normalizer.backgroundCount() > 0;
  }

  #applySession(event: Extract<NormalizedEvent, { type: "session" }>): void {
    this.nativeSessionId = event.nativeSessionId;
    this.#forkFrom = undefined;
    this.#resumeAt = undefined;
  }

  /** One `next()` per iterator at a time; a reader that gives up leaves it for the next owner. */
  #read(iterator: AsyncIterator<ClaudeMessage>): Promise<IteratorResult<ClaudeMessage>> {
    if (this.#inflight?.iterator === iterator) return this.#inflight.promise;
    const promise = iterator.next();
    promise.catch(() => undefined); // an abandoned read must not surface as an unhandled rejection
    this.#inflight = { iterator, promise };
    return promise;
  }

  #claim(promise: Promise<IteratorResult<ClaudeMessage>>): void {
    if (this.#inflight?.promise === promise) this.#inflight = undefined;
  }

  #startIdle(): void {
    const iterator = this.#iterator;
    if (!iterator || this.#closed) return;
    const gen = ++this.#idleGen;
    this.#idleLoop(iterator, gen).catch((error: unknown) => {
      this.#env.log(`[claude] idle reader failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  #stopIdle(): void {
    this.#idleGen++;
  }

  #idleOwns(iterator: AsyncIterator<ClaudeMessage>, gen: number): boolean {
    return !this.#closed && this.#idleGen === gen && this.#iterator === iterator;
  }

  async #idleLoop(iterator: AsyncIterator<ClaudeMessage>, gen: number): Promise<void> {
    while (this.#idleOwns(iterator, gen)) {
      const pending = this.#read(iterator);
      let step: IteratorResult<ClaudeMessage>;
      try {
        step = await pending;
      } catch (error) {
        if (!this.#idleOwns(iterator, gen)) return;
        this.#claim(pending);
        this.#idleEnded(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!this.#idleOwns(iterator, gen)) return; // a send took over and consumes this read
      this.#claim(pending);
      if (step.done) {
        this.#idleEnded(undefined);
        return;
      }
      await this.#idleMessage(step.value);
    }
  }

  async #idleMessage(message: ClaudeMessage): Promise<void> {
    const reported = this.#normalizer.notificationName(message);
    const events = this.#normalizer.next(message);
    if (reported !== undefined && !this.#harness) this.#openHarness(reportedReason(reported));
    for (const event of events) {
      if (event.type === "session") this.#applySession(event);
      if (event.type === "settled") {
        const turn = this.#harness;
        if (!turn) {
          this.#preamble.clear();
          continue;
        }
        // a steer that missed the fold runs as the CLI's next turn: it stays this harness turn.
        // After an interrupt it is not torn down (that would kill the background sub-agents):
        // the CLI runs it next, and the idle loop surfaces that as a harness turn of its own.
        if (this.#afterResult(message as ResultMessage, event.status, turn.pendingSteers) === "continue") continue;
        turn.ending = true; // from here a steer would land after the turn: refuse it
        await this.#settleHarness(turn, event);
        continue;
      }
      if (this.#harness) {
        this.#harness.push(event);
        continue;
      }
      if (!isSubstantive(event)) {
        if (isIdleActivity(event) && this.#idleActivityListener) this.#deliverIdle(this.#idleActivityListener, event);
        else this.#preamble.add(event);
        continue;
      }
      const reason = event.type === "activity" && event.activity.kind === "child" ? reportedReason(event.activity.name) : CONTINUED_REASON;
      this.#openHarness(reason).push(event);
    }
  }

  #deliverIdle(listener: (event: NormalizedEvent) => void, event: NormalizedEvent): void {
    try {
      listener(event);
    } catch (error) {
      this.#env.log(`[claude] idle-activity listener threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #openHarness(reason: string): HarnessTurn {
    const turn = new HarnessTurn(reason);
    this.#harness = turn;
    this.#interruptRequested = false;
    for (const event of this.#preamble.take()) turn.push(event);
    const listener = this.#harnessListener;
    if (listener) {
      try {
        listener({ reason, events: turn.mailbox.drain() });
      } catch (error) {
        this.#env.log(`[claude] harness-turn listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
      return turn;
    }
    if (!this.#warnedNoListener) {
      this.#warnedNoListener = true;
      this.#env.log(`[claude] Claude Code started a turn on its own (${reason}) but nobody listens; its output is dropped`);
    }
    void (async () => {
      for await (const _event of turn.mailbox.drain()) {
        // drained so the turn still settles and the CLI is never left unread
      }
    })();
    return turn;
  }

  async #settleHarness(turn: HarnessTurn, event: Extract<NormalizedEvent, { type: "settled" }>): Promise<void> {
    const contextUsage = await this.#contextUsage();
    if (contextUsage) turn.push({ type: "usage", contextUsage });
    turn.push(event);
    this.#endHarness(turn);
  }

  #endHarness(turn: HarnessTurn): void {
    if (this.#harness === turn) this.#harness = undefined;
    turn.finish();
  }

  /** The iterator ended or threw while no send owned it: the CLI is gone, the next send resumes. */
  #idleEnded(error: string | undefined): void {
    const turn = this.#harness;
    if (turn) {
      turn.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: error ?? "claude stream ended before the turn settled" });
      this.#endHarness(turn);
    }
    if (error !== undefined) this.#env.log(`[claude] stream failed between turns: ${error}`);
    this.#resetQuery();
  }

  #buildOptions(): Record<string, unknown> {
    const options = this.#options;
    const mcpServers: Record<string, unknown> = {};
    for (const server of options.mcpServers) {
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
    }
    const model = options.model ?? this.#config.defaultModel;
    const env = { ...process.env, ...instanceEnv(this.#config, this.#env), ...options.env };

    return {
      cwd: options.cwd,
      abortController: this.#abort,
      includePartialMessages: true,
      permissionMode: this.#permissionMode,
      env,
      stderr: (data: string) => this.#env.log(`[claude:stderr] ${data.trimEnd()}`),
      canUseTool: (toolName: string, input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResultShape> =>
        this.#broker.handle(toolName, input, context),
      ...(model ? { model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(this.#forkFrom ? { resume: this.#forkFrom, forkSession: true } : this.nativeSessionId ? { resume: this.nativeSessionId } : {}),
      ...(this.#resumeAt ? { resumeSessionAt: this.#resumeAt } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      // Every link (read-only ones too) is added: the SDK's workspace gate covers reads as
      // well as writes, and a read-only link that is not listed could not even be read.
      // Edits under a read-only link are denied in `canUseTool` instead — see links.ts.
      ...(options.linkedDirs && options.linkedDirs.length > 0 ? { additionalDirectories: options.linkedDirs.map((dir) => dir.path) } : {}),
      ...(this.#permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      // ALWAYS set, append or not: the SDK reads an omitted `systemPrompt` as an *empty custom*
      // prompt, which would silently strip the Claude Code system prompt — the definition of
      // crippling the harness (CLAUDE.md §1a). The preset is the only non-crippling value.
      systemPrompt: { type: "preset", preset: "claude_code", ...(options.systemPromptAppend ? { append: options.systemPromptAppend } : {}) },
      ...(this.#binaryPath ? { pathToClaudeCodeExecutable: this.#binaryPath } : {}),
      // Deliberately NOT set: `settingSources` and `strictMcpConfig`. Tide must not strip the
      // user's settings, skills, hooks, plugins or project `.claude/` config (CLAUDE.md §1a).
    };
  }

  #ensureQuery(): AsyncIterator<ClaudeMessage> {
    if (this.#iterator) return this.#iterator;
    this.#query = this.#queryFn({ prompt: this.#inbox.drain(), options: this.#buildOptions() });
    this.#iterator = this.#query[Symbol.asyncIterator]();
    return this.#iterator;
  }

  /**
   * `auto` reached the CLI's permission-mode union only in recent builds. If the very first
   * pull of a fresh session rejects it, downgrade to `acceptEdits` once and rebuild.
   */
  #shouldFallbackFromAuto(error: unknown): boolean {
    if (!this.#autoModeFallbackAvailable || this.#started) return false;
    const text = error instanceof Error ? error.message : String(error);
    return /permission[- ]?mode|\bauto\b/i.test(text);
  }

  #rebuildForAcceptEdits(): AsyncIterator<ClaudeMessage> {
    this.#autoModeFallbackAvailable = false;
    this.#permissionMode = "acceptEdits";
    this.#env.log("[claude] permissionMode 'auto' rejected by the installed CLI; falling back to 'acceptEdits'");
    this.#emit({ type: "activity", activity: { kind: "info", text: "This Claude Code build has no `auto` permission mode; using `acceptEdits`." } });
    const previous = this.#inbox;
    this.#inbox = new AsyncQueue<UserMessageEnvelope>();
    this.#iterator = undefined;
    void previous;
    return this.#ensureQuery();
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("claude session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this claude session");
    this.#turnActive = true;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    const pending = buildUserMessage(input, this.nativeSessionId ?? "");
    this.#prompts.push(pending.uuid);
    this.#turnMessages = [pending];
    this.#pendingSteers.clear();
    this.#turnFed = false;
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      try {
        // Claude Code is running a turn of its own: this send queues behind it
        while (self.#harness) await self.#harness.done;
        if (self.#closed) {
          yield { type: "settled", status: "interrupted", error: "claude session closed" };
          return;
        }
        self.#stopIdle();
        self.#interruptRequested = false;
        self.#mailbox = mailbox;
        const pump = self.#pump(mailbox);
        for await (const event of mailbox.drain()) yield event;
        await pump;
      } finally {
        self.#turnActive = false;
        if (self.#mailbox === mailbox) self.#mailbox = undefined;
        self.#turnMessages = [];
        self.#pendingSteers.clear();
      }
    }
    return stream();
  }

  async #pump(mailbox: AsyncQueue<NormalizedEvent>): Promise<void> {
    let idle = false;
    try {
      let iterator = this.#ensureQuery();
      for (const message of this.#turnMessages) this.#inbox.push(message);
      this.#turnFed = true;
      for (;;) {
        let step: IteratorResult<ClaudeMessage>;
        const pending = this.#read(iterator);
        try {
          step = await pending;
        } catch (error) {
          this.#claim(pending);
          if (!this.#shouldFallbackFromAuto(error)) throw error;
          iterator = this.#rebuildForAcceptEdits();
          for (const message of this.#turnMessages) this.#inbox.push(message);
          continue;
        }
        this.#claim(pending);
        this.#started = true;
        if (step.done) {
          this.#abandonBackground();
          mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: "claude stream ended before the turn settled" });
          return;
        }
        const events = this.#normalizer.next(step.value);
        for (const event of events) {
          if (event.type === "session") this.#applySession(event);
          if (event.type === "settled") {
            const after = this.#afterResult(step.value as ResultMessage, event.status, this.#pendingSteers);
            if (after === "continue") continue; // a steer missed the fold: its own turn follows

            const contextUsage = await this.#contextUsage();
            if (contextUsage) mailbox.push({ type: "usage", contextUsage });
            mailbox.push(event);
            if (after === "reset") this.#resetQuery();
            else idle = true;
            return;
          }
          mailbox.push(event);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#abandonBackground();
      mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: message });
    } finally {
      mailbox.close();
      if (this.#mailbox === mailbox) this.#mailbox = undefined;
      // Claude Code may keep going on its own (background sub-agents reporting): keep reading
      if (idle) this.#startIdle();
    }
  }

  /**
   * Whether a `result` ends the Tide turn. A steer the CLI has not consumed yet with more sends
   * still queued runs as its own CLI turn next: keep streaming into this Tide turn
   * (`continue`). After an interrupt such a steer would run on its own once the turn is gone,
   * so the query is torn down instead (`reset`) and the next send resumes the transcript.
   */
  #afterResult(result: ResultMessage, status: "completed" | "interrupted" | "error", pending: Set<string>): "end" | "continue" | "reset" {
    for (const uuid of result.user_message_uuids ?? []) pending.delete(uuid);
    if (pending.size === 0 || (result.queued_turn_count ?? 0) === 0) return "end";
    if (status === "interrupted" || this.#interruptRequested) return "reset";
    return "continue";
  }

  /** Ends the live CLI process; the next `send()` builds a new query from `#buildOptions`. */
  #resetQuery(): void {
    const iterator = this.#iterator;
    this.#abandonBackground();
    this.#stopIdle();
    this.#inflight = undefined;
    this.#preamble.clear();
    this.#inbox.close();
    try {
      this.#abort.abort();
    } catch {
      // an already-aborted controller is fine
    }
    void iterator?.return?.(undefined).catch(() => undefined);
    this.#abort = new AbortController();
    this.#inbox = new AsyncQueue<UserMessageEnvelope>();
    this.#iterator = undefined;
    this.#query = undefined;
    this.#normalizer = this.#newNormalizer();
  }

  /**
   * The CLI process ended (stream end, crash, a reset): background sub-agents died with it and
   * will never report. Their rows are closed as failed through the idle-activity channel, which
   * lands each on its own row and turn, whatever turn (if any) is running now.
   */
  #abandonBackground(): void {
    const events = this.#normalizer.abandonBackground(LOST_BACKGROUND_SUMMARY);
    if (events.length === 0) return;
    this.#env.log(`[claude] ${events.length} background sub-agent(s) lost with the CLI process`);
    const listener = this.#idleActivityListener;
    if (listener) for (const event of events) this.#deliverIdle(listener, event);
  }

  /**
   * The `result` message's token counts are cumulative per query() call, so they cannot be
   * read as "context in use". The CLI's own `get_context_usage` control request can, so we
   * ask for it once per settled turn. Best effort: an older CLI simply has no such method.
   */
  async #contextUsage(): Promise<{ used: number; window: number } | undefined> {
    const getter = this.#query?.getContextUsage;
    if (!getter || !this.#query) return undefined;
    try {
      const report = await getter.call(this.#query);
      const used = report.totalTokens;
      const window = report.rawMaxTokens ?? report.maxTokens;
      if (typeof used !== "number" || typeof window !== "number" || window <= 0) return undefined;
      return { used, window };
    } catch (error) {
      this.#env.log(`[claude] getContextUsage failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Claude switches in place: `setPermissionMode`/`setModel` are streaming-input control
   * requests on the live Query, so a mode or model change never costs the session. Before
   * the first turn there is no Query yet — the new values simply go into `#buildOptions`.
   * Anything the installed CLI rejects falls back to a reopen.
   */
  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    const permissionMode = settings.interaction === "plan" ? "plan" : (MODE_TO_PERMISSION[settings.mode] ?? "default");
    const model = settings.model;
    const modelChanged = model !== this.#options.model;
    const modeChanged = permissionMode !== this.#permissionMode;
    const effort = settings.effort;
    const effortChanged = effort !== this.#options.effort;

    this.#options = { ...this.#options, mode: settings.mode, interaction: settings.interaction, ...(model !== undefined ? { model } : {}) };
    if (model === undefined) delete (this.#options as { model?: string }).model;
    this.#options = { ...this.#options, ...(effort !== undefined ? { effort } : {}) };
    if (effort === undefined) delete (this.#options as { effort?: string }).effort;
    this.#permissionMode = permissionMode;

    const query = this.#query;
    if (!query) return "applied"; // nothing started yet: #buildOptions carries the new values
    try {
      if (modeChanged) {
        if (!query.setPermissionMode) return "reopen";
        await query.setPermissionMode.call(query, permissionMode);
        this.#autoModeFallbackAvailable = false;
      }
      if (modelChanged) {
        if (!query.setModel) return "reopen";
        await query.setModel.call(query, model ?? this.#config.defaultModel);
      }
      if (effortChanged) {
        // `null` clears the flag layer back to the model's default effort
        if (!query.applyFlagSettings) return "reopen";
        await query.applyFlagSettings.call(query, { effortLevel: effort ?? null });
      }
    } catch (error) {
      this.#env.log(`[claude] reconfigure failed, reopening: ${error instanceof Error ? error.message : String(error)}`);
      return "reopen";
    }
    return "applied";
  }

  /**
   * Into the running send, else into the harness turn. A send waiting behind a harness turn is
   * the server's live turn, so it takes the steer (delivered with its prompt). A harness turn is
   * already fed: the message goes straight into the live input and the CLI folds it in like any
   * steer, acknowledged by the harness turn's `result` (`user_message_uuids`). Once that turn's
   * final `result` is read the steer is refused, never dropped: the server queues it instead.
   */
  async steer(input: TurnInput): Promise<void> {
    const harness = this.#turnActive ? undefined : this.#harness;
    if (this.#closed || (!this.#turnActive && !harness)) throw new Error("no turn is running on this claude session");
    if (harness?.ending) throw new Error("the claude turn is ending; the message cannot join it");
    const message = buildUserMessage(input, this.nativeSessionId ?? "");
    this.#steers.add(message.uuid);
    if (harness) {
      harness.pendingSteers.add(message.uuid);
      this.#inbox.push(message);
      return;
    }
    this.#pendingSteers.add(message.uuid);
    this.#turnMessages.push(message);
    if (this.#turnFed) this.#inbox.push(message);
  }

  /**
   * Forgets the last `turns` turns: finds the kept turn's last transcript entry and arms a
   * truncating resume (`resumeSessionAt`) for the next query. Dropping every turn starts a
   * new session instead. Works on a fork that has not run yet (the source's transcript).
   */
  async rollback(turns: number): Promise<void> {
    if (this.#closed) throw new Error("claude session is closed");
    if (this.#turnActive || this.#harness) throw new Error("busy: cannot roll back while a turn is running");
    if (turns <= 0) return;
    const source = this.#forkFrom ?? this.nativeSessionId;
    if (source === undefined) throw new Error(`invalid-params: cannot roll back ${turns} turn(s); the claude session has no history`);
    this.#sessionMessages ??= this.#config.sessionMessagesImpl ?? (await sdkSessionMessages());
    let entries: TranscriptEntry[] = await this.#sessionMessages(source, { dir: this.#options.cwd, includeSystemMessages: true });
    if (this.#resumeAt !== undefined) {
      // an earlier rollback not applied yet: its dropped tail is still on disk
      const at = entries.findIndex((entry) => entry.uuid === this.#resumeAt);
      if (at >= 0) entries = entries.slice(0, at + 1);
    }
    const point = rollbackPoint(entries, { prompts: this.#prompts, steers: this.#steers }, turns);
    const kept = new Set(entries.slice(0, point.kind === "at" ? entries.findIndex((entry) => entry.uuid === point.uuid) + 1 : 0).map((entry) => entry.uuid));
    this.#prompts = this.#prompts.filter((uuid) => kept.has(uuid));
    if (this.#query) this.#resetQuery();
    if (point.kind === "at") {
      this.#resumeAt = point.uuid;
      return;
    }
    // nothing kept: the next turn opens a brand-new session
    this.#resumeAt = undefined;
    this.#forkFrom = undefined;
    this.nativeSessionId = undefined;
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    this.#broker.respondApproval(requestId, decision);
  }

  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    this.#broker.respondUserInput(requestId, answers);
  }

  async interrupt(): Promise<void> {
    this.#interruptRequested = true;
    // marking an idle normalizer would mislabel whatever turn comes next as interrupted
    if (this.#turnActive || this.#harness) this.#normalizer.markInterrupted();
    this.#broker.cancelAll();
    const interrupt = this.#query?.interrupt;
    if (!interrupt || !this.#query) return;
    try {
      await interrupt.call(this.#query);
    } catch (error) {
      this.#env.log(`[claude] interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopIdle();
    this.#broker.cancelAll();
    this.#inbox.close();
    this.#mailbox?.close();
    const turn = this.#harness;
    if (turn) {
      turn.push({ type: "settled", status: "interrupted", error: "claude session closed" });
      this.#endHarness(turn);
    }
    try {
      this.#abort.abort();
    } catch {
      // an already-aborted controller is fine
    }
    const iterator = this.#iterator;
    const reading = this.#inflight !== undefined;
    this.#inflight = undefined;
    // with a `next()` pending, `return()` queues behind it: abort ends the CLI, don't wait on it
    if (reading) void iterator?.return?.(undefined).catch(() => undefined);
    else await iterator?.return?.(undefined).catch(() => undefined);
  }
}
