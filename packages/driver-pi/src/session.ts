import type { ApprovalDecision, DriverEnv, NormalizedEvent, OpenSessionOptions, ProviderSession, ReconfigureResult, SessionSettings, TurnInput, TurnUsage } from "@tide/contracts";
import { CONFIG_COMMAND, formatConfigCommand } from "@tide/pi-extensions/protocol";
import { PiApprovalBroker } from "./approvals.ts";
import { AsyncQueue } from "./async-queue.ts";
import { PiNormalizer } from "./normalize.ts";
import { PiRpc } from "./rpc.ts";
import { splitModelId } from "./spawn.ts";
import type { ChildLike, PiCommandInfo, PiDeps, PiEvent, PiPromptDisposition, PiResponse, PiSessionStats, PiState, PiUiRequest } from "./types.ts";

/**
 * One long-lived `pi --mode rpc` process per Tide thread.
 *
 * pi keeps its own session file, so a process per thread is the natural unit: `send()` is one
 * `prompt` command, events stream until `agent_settled`, and `abort` interrupts. Like the
 * Claude driver, `send()` runs one turn at a time — pi rejects a second `prompt` while
 * streaming unless it is explicitly queued as `steer`/`followUp`, which is a different feature
 * (the server queues turns itself).
 *
 * The `prompt` response's `data.disposition` (pi 0.99+, docs/rpc-commands.md § prompt) decides
 * how the turn ends: `started`/`queued` → wait for `agent_settled`; `handled` (an extension
 * command or input handler consumed it) → no run will start, so the turn settles at once.
 */

export function promptDisposition(response: PiResponse): PiPromptDisposition | undefined {
  const value = (response.data as { disposition?: unknown } | undefined)?.disposition;
  return value === "started" || value === "queued" || value === "handled" ? value : undefined;
}

function pushImages(command: Record<string, unknown>, input: TurnInput): void {
  const images = input.images ?? [];
  if (images.length === 0) return;
  command["images"] = images.map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType }));
}

function toTurnUsage(before: PiSessionStats | undefined, after: PiSessionStats): TurnUsage | undefined {
  const tokens = after.tokens;
  if (!tokens) return undefined;
  const previous = before?.tokens;
  const delta = (key: "input" | "output" | "cacheRead" | "cacheWrite"): number => Math.max(0, (tokens[key] ?? 0) - (previous?.[key] ?? 0));
  const cost = typeof after.cost === "number" ? Math.max(0, after.cost - (before?.cost ?? 0)) : undefined;
  return {
    inputTokens: delta("input"),
    outputTokens: delta("output"),
    cacheReadTokens: delta("cacheRead"),
    cacheWriteTokens: delta("cacheWrite"),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

/** pi reports a placeholder `unknown` model when no provider is configured; don't surface it. */
function modelId(state: PiState | undefined): string | undefined {
  const model = state?.model;
  if (!model?.id || model.id === "unknown") return undefined;
  return model.provider && model.provider !== "unknown" ? `${model.provider}/${model.id}` : model.id;
}

export class PiSession implements ProviderSession {
  nativeSessionId: string | undefined;

  #env: DriverEnv;
  #options: OpenSessionOptions;
  #rpc: PiRpc;
  #child: ChildLike;
  #broker: PiApprovalBroker;
  #normalizer: PiNormalizer;
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;
  #model: string | undefined;
  #stats: PiSessionStats | undefined;
  #turnActive = false;
  #closed = false;
  #interruptRequested = false;
  #announcedSession = false;
  #mode: OpenSessionOptions["mode"];
  #interaction: OpenSessionOptions["interaction"];
  /** tide-bridge's `/tide-config` is loaded, so mode / plan mode can change in place */
  #liveConfig = false;

  constructor(child: ChildLike, env: DriverEnv, options: OpenSessionOptions) {
    this.#child = child;
    this.#env = env;
    this.#options = options;
    this.#mode = options.mode;
    this.#interaction = options.interaction;
    this.#normalizer = new PiNormalizer({
      onUnknown: (type) => {
        if (process.env["TIDE_DEBUG_PI"]) env.log(`[pi] unhandled event ${type}`);
      },
    });
    this.#rpc = new PiRpc(child, {
      onLine: (line) => this.#route(line as PiEvent),
      log: (message) => env.log(message),
      // pi can die mid-turn (crash, OOM, a killed terminal). Failing the pending requests is
      // not enough: `prompt` has already resolved by then, so the mailbox would stay open
      // forever and the thread would sit "running" with nothing on the other end.
      onExit: (error) => this.#died(error),
    });
    this.#broker = new PiApprovalBroker(
      (event) => this.#emit(event),
      (id, body) => this.#rpc.notify({ type: "extension_ui_response", id, ...body }),
      options.cwd,
    );
  }

  /** Reads pi's own session identity; called once by the instance right after spawning. */
  async prime(): Promise<void> {
    const state = await this.#rpc.data<PiState>({ type: "get_state" });
    this.nativeSessionId = state?.sessionFile ?? state?.sessionId ?? this.#options.resume;
    this.#model = modelId(state);
    this.#stats = await this.#rpc.data<PiSessionStats>({ type: "get_session_stats" });
    const commands = await this.#rpc.data<{ commands?: PiCommandInfo[] }>({ type: "get_commands" });
    this.#liveConfig = (commands?.commands ?? []).some((command) => command.name === CONFIG_COMMAND && command.source === "extension");
  }

  #emit(event: NormalizedEvent): void {
    this.#mailbox?.push(event);
  }

  /** The pi process is gone: settle whatever turn was running instead of hanging on it. */
  #died(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.cancelAll();
    this.#mailbox?.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: error.message });
    this.#mailbox?.close();
  }

  #route(line: PiEvent): void {
    if (line.type === "extension_ui_request") {
      this.#broker.handle(line as unknown as PiUiRequest);
      return;
    }
    if (line.type === "response") return; // an uncorrelated response; nothing to do
    for (const event of this.#normalizer.next(line)) {
      if (event.type === "settled") {
        void this.#finish(event);
        return;
      }
      this.#emit(event);
    }
  }

  /**
   * Usage comes from the `get_session_stats` RPC, which is authoritative: its `tokens`/`cost`
   * are session totals (so the turn's usage is the delta against the previous snapshot) and its
   * `contextUsage` is the same estimate pi uses for compaction. tide-bridge's `TIDE_USAGE:`
   * notify is only the fallback when the command is unavailable.
   */
  async #finish(settled: NormalizedEvent): Promise<void> {
    const mailbox = this.#mailbox;
    try {
      const stats = await this.#rpc.data<PiSessionStats>({ type: "get_session_stats" });
      if (stats) {
        const usage = toTurnUsage(this.#stats, stats);
        const context = stats.contextUsage;
        const contextUsage = context && typeof context.tokens === "number" && context.contextWindow > 0 ? { used: context.tokens, window: context.contextWindow } : undefined;
        this.#stats = stats;
        if (usage || contextUsage) mailbox?.push({ type: "usage", ...(usage ? { usage } : {}), ...(contextUsage ? { contextUsage } : {}) });
        if (stats.sessionFile) this.nativeSessionId = stats.sessionFile;
      }
    } catch (error) {
      this.#env.log(`[pi] get_session_stats failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    mailbox?.push(settled);
    mailbox?.close();
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("pi session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this pi session");
    this.#turnActive = true;
    this.#interruptRequested = false;
    this.#normalizer.beginTurn();
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    if (!this.#announcedSession && this.nativeSessionId) {
      this.#announcedSession = true;
      mailbox.push({ type: "session", nativeSessionId: this.nativeSessionId, ...(this.#model ? { model: this.#model } : {}) });
    }

    const command: Record<string, unknown> = { type: "prompt", message: input.text };
    pushImages(command, input);
    void this.#rpc
      .request(command)
      .then((response) => {
        if (!response.success) {
          mailbox.push({ type: "settled", status: "error", error: response.error ?? "pi rejected the prompt" });
          mailbox.close();
          return;
        }
        // `handled`: an extension command (`/foo`) or input handler consumed the prompt and no
        // run starts, so no `agent_settled` will come. `started`/`queued`, and a pre-0.99 pi
        // that sends no disposition, end on `agent_settled`.
        if (promptDisposition(response) === "handled") {
          mailbox.push({ type: "settled", status: "completed" });
          mailbox.close();
        }
      })
      .catch((error: unknown) => {
        mailbox.push({ type: "settled", status: this.#interruptRequested ? "interrupted" : "error", error: error instanceof Error ? error.message : String(error) });
        mailbox.close();
      });

    const self = this;
    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      try {
        for await (const event of mailbox.drain()) yield event;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
      }
    }
    return stream();
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    this.#broker.respondApproval(requestId, decision);
  }

  /** Answers an extension's `select`/`input`/`editor` dialog (see approvals.ts). */
  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    this.#broker.respondUserInput(requestId, answers);
  }

  /**
   * Live where pi allows it:
   *  - model → `set_model {provider, modelId}` (docs/rpc-commands.md § set_model);
   *  - runtime mode / plan mode → tide-bridge's `/tide-config` command, sent as a `prompt`
   *    that pi answers `disposition:"handled"` without a model call.
   * Anything that cannot be applied in place (a bare model pattern, an unknown model, a pi
   * without the bridge command) answers `reopen`: the server restarts the process with
   * `--session <file>`, which loses no history.
   */
  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    if (this.#closed || this.#turnActive) return "reopen";
    try {
      if (settings.model !== undefined && settings.model !== this.#model) {
        const target = splitModelId(settings.model);
        if (!target) return "reopen";
        const response = await this.#rpc.request({ type: "set_model", ...target });
        if (!response.success) {
          this.#env.log(`[pi] set_model ${settings.model} failed: ${response.error ?? "unknown"}`);
          return "reopen";
        }
        this.#model = modelId({ model: (response.data as PiState["model"]) ?? null }) ?? settings.model;
      }
      if (settings.mode !== this.#mode || settings.interaction !== this.#interaction) {
        if (!this.#liveConfig) return "reopen";
        const response = await this.#rpc.request({ type: "prompt", message: formatConfigCommand({ mode: settings.mode, plan: settings.interaction === "plan" }) });
        if (!response.success || promptDisposition(response) !== "handled") return "reopen";
        this.#mode = settings.mode;
        this.#interaction = settings.interaction;
      }
      return "applied";
    } catch (error) {
      this.#env.log(`[pi] reconfigure failed: ${error instanceof Error ? error.message : String(error)}`);
      return "reopen";
    }
  }

  async interrupt(): Promise<void> {
    this.#interruptRequested = true;
    this.#normalizer.markInterrupted();
    this.#broker.cancelAll();
    try {
      await this.#rpc.request({ type: "abort" });
    } catch (error) {
      this.#env.log(`[pi] abort failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.cancelAll();
    this.#mailbox?.close();
    this.#rpc.close();
  }
}

export type { PiDeps };
