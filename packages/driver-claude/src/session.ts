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
import { ClaudeNormalizer } from "./normalize.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import type { ClaudeConfig, QueryFn, QueryLike } from "./types.ts";

/**
 * Streaming-input mode: one `query()` per session, fed by an async iterable we push user
 * messages into, so every turn of a thread runs in the same CLI process.
 *
 * Chosen over "one `query()` per turn with `resume`" because the whole Query control plane
 * — `interrupt()`, `setPermissionMode()`, `getContextUsage()`, `supportedModels()` — is
 * documented as streaming-input-only, and because respawning the CLI per turn re-launches
 * every MCP server and re-reads the transcript on each send. The cost is that `send()` is
 * strictly one turn at a time (see the `busy` guard below).
 */

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
  #iterator: AsyncIterator<ClaudeMessage> | undefined;
  #permissionMode: string;
  #autoModeFallbackAvailable: boolean;
  #started = false;
  #turnActive = false;
  #closed = false;
  #interruptRequested = false;

  constructor(config: ClaudeConfig, env: DriverEnv, options: OpenSessionOptions, queryFn: QueryFn, binaryPath?: string) {
    this.#config = config;
    this.#env = env;
    this.#options = options;
    this.#queryFn = queryFn;
    if (binaryPath !== undefined) this.#binaryPath = binaryPath;
    if (options.resume !== undefined) this.nativeSessionId = options.resume;
    this.#permissionMode = options.interaction === "plan" ? "plan" : (MODE_TO_PERMISSION[options.mode] ?? "default");
    this.#autoModeFallbackAvailable = this.#permissionMode === "auto";
    this.#broker = new ApprovalBroker((event) => this.#emit(event), options.linkedDirs ?? []);
    this.#normalizer = new ClaudeNormalizer({
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
    const env = { ...process.env, ...this.#config.env, ...options.env };

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
      ...(this.nativeSessionId ? { resume: this.nativeSessionId } : {}),
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
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      const pump = self.#pump(mailbox, pending);
      try {
        for await (const event of mailbox.drain()) yield event;
        await pump;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
      }
    }
    return stream();
  }

  async #pump(mailbox: AsyncQueue<NormalizedEvent>, pending: UserMessageEnvelope): Promise<void> {
    try {
      let iterator = this.#ensureQuery();
      this.#inbox.push(pending);
      for (;;) {
        let step: IteratorResult<ClaudeMessage>;
        try {
          step = await iterator.next();
        } catch (error) {
          if (!this.#shouldFallbackFromAuto(error)) throw error;
          iterator = this.#rebuildForAcceptEdits();
          this.#inbox.push(pending);
          continue;
        }
        this.#started = true;
        if (step.done) {
          mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: "claude stream ended before the turn settled" });
          return;
        }
        const events = this.#normalizer.next(step.value);
        for (const event of events) {
          if (event.type === "session") this.nativeSessionId = event.nativeSessionId;
          if (event.type === "settled") {
            const contextUsage = await this.#contextUsage();
            if (contextUsage) mailbox.push({ type: "usage", contextUsage });
            mailbox.push(event);
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

    this.#options = { ...this.#options, mode: settings.mode, interaction: settings.interaction, ...(model !== undefined ? { model } : {}) };
    if (model === undefined) delete (this.#options as { model?: string }).model;
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
    } catch (error) {
      this.#env.log(`[claude] reconfigure failed, reopening: ${error instanceof Error ? error.message : String(error)}`);
      return "reopen";
    }
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
