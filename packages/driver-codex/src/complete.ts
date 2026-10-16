import type { CompletionRequest, CompletionResult, DriverEnv, TurnUsage } from "@tide/contracts";
import { AppServer, mergedEnv } from "./app-server.ts";
import type { CodexConfig } from "./types.ts";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts";

/** The shared completion server is reaped after this long without a call. */
export const COMPLETION_IDLE_MS = 5 * 60_000;

interface Waiter {
  onNotification(method: string, params: Record<string, unknown>): void;
}

/**
 * One-shot, tools-off completions over a single lazily-started `codex app-server` (not per call).
 * Each call is an ephemeral read-only thread with one low-effort turn; the thread is archived after.
 */
export class CompletionService {
  #config: CodexConfig;
  #env: DriverEnv;
  #binaryPath: () => Promise<string>;
  #server: Promise<AppServer> | undefined;
  #waiters = new Map<string, Waiter>();
  #idle: ReturnType<typeof setTimeout> | undefined;
  #active = 0;
  #disposed = false;

  constructor(config: CodexConfig, env: DriverEnv, binaryPath: () => Promise<string>) {
    this.#config = config;
    this.#env = env;
    this.#binaryPath = binaryPath;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.#disposed) throw new Error("codex completion service is disposed");
    const started = Date.now();
    this.#active++;
    this.#cancelIdle();
    try {
      const server = await this.#serverFor(request.cwd);
      return await this.#run(server, request, started);
    } finally {
      this.#active--;
      if (this.#active === 0) this.#armIdle();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelIdle();
    this.#reap();
  }

  #serverFor(cwd: string): Promise<AppServer> {
    this.#server ??= this.#binaryPath()
      .then((binaryPath) =>
        AppServer.start({
          binaryPath,
          cwd,
          env: mergedEnv(this.#config),
          ...(this.#config.spawnImpl ? { spawn: this.#config.spawnImpl } : {}),
          log: (message) => this.#env.log(message),
          onNotification: (method, params) => {
            const threadId = (params as { threadId?: unknown } | null)?.threadId;
            if (typeof threadId === "string") this.#waiters.get(threadId)?.onNotification(method, params as Record<string, unknown>);
          },
          onExit: () => {
            this.#server = undefined;
          },
        }),
      )
      .catch((error: unknown) => {
        this.#server = undefined;
        throw error;
      });
    return this.#server;
  }

  async #run(server: AppServer, request: CompletionRequest, started: number): Promise<CompletionResult> {
    const model = request.model ?? this.#config.defaultModel;
    const thread = await server.request<ThreadStartResponse>("thread/start", {
      ephemeral: true,
      baseInstructions: request.system,
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd: request.cwd,
      ...(model ? { model } : {}),
    });
    const threadId = thread.thread.id;

    let text = "";
    let usage: TurnUsage | undefined;
    let turnId: string | undefined;
    let settle: (error?: Error) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    this.#waiters.set(threadId, {
      onNotification: (method, params) => {
        if (method === "item/completed") {
          const item = params["item"] as { type?: string; text?: unknown } | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") text = item.text;
        } else if (method === "thread/tokenUsage/updated") {
          const last = (params["tokenUsage"] as { total?: Record<string, number> } | undefined)?.total;
          if (last) {
            usage = {
              inputTokens: last["inputTokens"] ?? 0,
              outputTokens: last["outputTokens"] ?? 0,
              ...(last["cachedInputTokens"] !== undefined ? { cacheReadTokens: last["cachedInputTokens"] } : {}),
            };
          }
        } else if (method === "turn/completed") {
          const turn = params["turn"] as { status?: string; error?: { message?: string } } | undefined;
          if (turn?.status === "completed") settle();
          else settle(new Error(`codex completion ${turn?.status ?? "failed"}${turn?.error?.message ? `: ${turn.error.message}` : ""}`));
        }
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (): void => {
      if (turnId !== undefined) server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    };
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: codex completion exceeded ${request.timeoutMs}ms`)), request.timeoutMs);
        const abort = (): void => reject(new Error("timeout: codex completion aborted"));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort);
      });
      deadline.catch(() => undefined);
      const turn = server
        .request<TurnStartResponse>("turn/start", {
          threadId,
          input: [{ type: "text", text: request.prompt, text_elements: [] }],
          effort: "low",
          ...(request.labels && request.labels.length > 0 ? { outputSchema: { type: "string", enum: request.labels } } : {}),
        })
        .then((response) => {
          turnId = response.turn.id;
        });
      await Promise.race([Promise.all([turn, done]), deadline]);
    } catch (error) {
      interrupt();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#waiters.delete(threadId);
      server.request("thread/archive", { threadId }).catch(() => undefined);
    }

    const trimmed = text.trim();
    const label = request.labels?.find((candidate) => candidate.toLowerCase() === trimmed.replace(/^"|"$/g, "").toLowerCase());
    return {
      text: trimmed,
      ...(label !== undefined ? { label } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      elapsedMs: Date.now() - started,
    };
  }

  #cancelIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  #armIdle(): void {
    if (this.#disposed) return;
    this.#idle = setTimeout(() => this.#reap(), COMPLETION_IDLE_MS);
    this.#idle.unref?.();
  }

  #reap(): void {
    const server = this.#server;
    this.#server = undefined;
    void server?.then((s) => s.close()).catch(() => undefined);
  }
}
