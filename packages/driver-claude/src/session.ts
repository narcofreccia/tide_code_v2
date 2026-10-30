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
 */

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

  #emit(event: NormalizedEvent): void {
    this.#mailbox?.push(event);
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
    this.#interruptRequested = false;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    const pending = buildUserMessage(input, this.nativeSessionId ?? "");
    this.#prompts.push(pending.uuid);
    this.#turnMessages = [pending];
    this.#pendingSteers.clear();
    this.#turnFed = false;
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      const pump = self.#pump(mailbox);
      try {
        for await (const event of mailbox.drain()) yield event;
        await pump;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
        self.#turnMessages = [];
        self.#pendingSteers.clear();
      }
    }
    return stream();
  }

  async #pump(mailbox: AsyncQueue<NormalizedEvent>): Promise<void> {
    try {
      let iterator = this.#ensureQuery();
      for (const message of this.#turnMessages) this.#inbox.push(message);
      this.#turnFed = true;
      for (;;) {
        let step: IteratorResult<ClaudeMessage>;
        try {
          step = await iterator.next();
        } catch (error) {
          if (!this.#shouldFallbackFromAuto(error)) throw error;
          iterator = this.#rebuildForAcceptEdits();
          for (const message of this.#turnMessages) this.#inbox.push(message);
          continue;
        }
        this.#started = true;
        if (step.done) {
          mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: "claude stream ended before the turn settled" });
          return;
        }
        const events = this.#normalizer.next(step.value);
        for (const event of events) {
          if (event.type === "session") {
            this.nativeSessionId = event.nativeSessionId;
            this.#forkFrom = undefined;
            this.#resumeAt = undefined;
          }
          if (event.type === "settled") {
            const after = this.#afterResult(step.value as ResultMessage, event.status);
            if (after === "continue") continue; // a steer missed the fold: its own turn follows

            const contextUsage = await this.#contextUsage();
            if (contextUsage) mailbox.push({ type: "usage", contextUsage });
            mailbox.push(event);
            if (after === "reset") this.#resetQuery();
            return;
          }
          mailbox.push(event);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: message });
    } finally {
      mailbox.close();
    }
  }

  /**
   * Whether a `result` ends the Tide turn. A steer the CLI has not consumed yet with more sends
   * still queued runs as its own CLI turn next: keep streaming into this Tide turn
   * (`continue`). After an interrupt such a steer would run on its own once the turn is gone,
   * so the query is torn down instead (`reset`) and the next send resumes the transcript.
   */
  #afterResult(result: ResultMessage, status: "completed" | "interrupted" | "error"): "end" | "continue" | "reset" {
    for (const uuid of result.user_message_uuids ?? []) this.#pendingSteers.delete(uuid);
    if (this.#pendingSteers.size === 0 || (result.queued_turn_count ?? 0) === 0) return "end";
    if (status === "interrupted" || this.#interruptRequested) return "reset";
    return "continue";
  }

  /** Ends the live CLI process; the next `send()` builds a new query from `#buildOptions`. */
  #resetQuery(): void {
    const iterator = this.#iterator;
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

  async steer(input: TurnInput): Promise<void> {
    if (this.#closed || !this.#turnActive) throw new Error("no turn is running on this claude session");
    const message = buildUserMessage(input, this.nativeSessionId ?? "");
    this.#steers.add(message.uuid);
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
    if (this.#turnActive) throw new Error("busy: cannot roll back while a turn is running");
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
    this.#normalizer.markInterrupted();
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
    this.#broker.cancelAll();
    this.#inbox.close();
    this.#mailbox?.close();
    try {
      this.#abort.abort();
    } catch {
      // an already-aborted controller is fine
    }
    await this.#iterator?.return?.(undefined).catch(() => undefined);
  }
}
