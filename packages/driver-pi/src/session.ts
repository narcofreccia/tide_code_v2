import type { ApprovalDecision, DriverEnv, NormalizedEvent, OpenSessionOptions, ProviderSession, TurnInput, TurnUsage } from "@tide/contracts";
import { ENV_CWD, ENV_INTERACTION, ENV_LINKED_DIRS, ENV_RUNTIME_MODE, ENV_SYSTEM_PROMPT_APPEND, ENV_THREAD_ID } from "@tide/pi-extensions/protocol";
import { PiApprovalBroker } from "./approvals.ts";
import { AsyncQueue } from "./async-queue.ts";
import { PiNormalizer } from "./normalize.ts";
import { PiRpc } from "./rpc.ts";
import type { ChildLike, PiConfig, PiDeps, PiEvent, PiSessionStats, PiState, PiUiRequest } from "./types.ts";

/**
 * One long-lived `pi --mode rpc` process per Tide thread.
 *
 * pi keeps its own session file, so a process per thread is the natural unit: `send()` is one
 * `prompt` command, events stream until `agent_settled`, and `abort` interrupts. Like the
 * Claude driver, `send()` runs one turn at a time — pi rejects a second `prompt` while
 * streaming unless it is explicitly queued as `steer`/`followUp`, which is a different feature.
 */

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

  constructor(child: ChildLike, env: DriverEnv, options: OpenSessionOptions) {
    this.#child = child;
    this.#env = env;
    this.#options = options;
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

  /** pi has no structured user-input request; the broker cancels those dialogs instead. */
  async respondUserInput(_requestId: string, _answers: Record<string, unknown>): Promise<void> {
    this.#env.log("[pi] respondUserInput ignored: pi has no user-input request type");
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

/** Argument vector + environment for one `pi --mode rpc` process. */
export function buildSpawn(
  options: OpenSessionOptions,
  config: PiConfig,
  bridgePath: string | undefined,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = ["--mode", "rpc"];
  if (bridgePath) args.push("-e", bridgePath);
  for (const extension of config.extraExtensions ?? []) args.push("-e", extension);
  if (options.resume) args.push("--session", options.resume);
  const model = options.model ?? config.defaultModel;
  if (model) args.push("--model", model);
  return {
    args,
    env: {
      ...process.env,
      ...config.env,
      ...options.env,
      [ENV_RUNTIME_MODE]: options.mode,
      [ENV_INTERACTION]: options.interaction,
      [ENV_THREAD_ID]: options.threadId,
      [ENV_CWD]: options.cwd,
      ...(options.linkedDirs && options.linkedDirs.length > 0 ? { [ENV_LINKED_DIRS]: JSON.stringify(options.linkedDirs) } : {}),
      ...(options.systemPromptAppend !== undefined ? { [ENV_SYSTEM_PROMPT_APPEND]: options.systemPromptAppend } : {}),
    },
  };
}

export type { PiDeps };
