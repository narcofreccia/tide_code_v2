import type { CompletionRequest, CompletionResult, DriverEnv, TurnUsage } from "@tide/contracts";
import type { ClaudeMessage, ResultMessage } from "./sdk-shapes.ts";
import type { ClaudeConfig, QueryFn } from "./types.ts";

/**
 * R6 one-shot completion (Tide's judge fallback). Unlike a thread session this deliberately
 * strips the harness down to a model endpoint: no tools, no user/project settings, no MCP,
 * one turn, nothing written to ~/.claude/projects. Option names verified against sdk.d.ts 0.3.296.
 */

/** Claude Code's StructuredOutput tool needs an object root, so the label is wrapped. */
export function labelSchema(labels: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { label: { type: "string", enum: labels } },
    required: ["label"],
    additionalProperties: false,
  };
}

export function buildCompletionOptions(
  request: CompletionRequest,
  config: ClaudeConfig,
  binaryPath: string | undefined,
  abortController: AbortController,
  log: DriverEnv["log"],
): Record<string, unknown> {
  const model = request.model ?? config.defaultModel;
  const labels = request.labels && request.labels.length > 0 ? request.labels : undefined;
  // No SDK option caps output tokens; the CLI honours this env var.
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...config.env,
    ...(request.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens) } : {}),
  };
  return {
    cwd: request.cwd,
    abortController,
    env,
    stderr: (data: string) => log(`[claude:complete:stderr] ${data.trimEnd()}`),
    systemPrompt: request.system,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    // verified live (CLI 2.1.x): the StructuredOutput answer fits in one turn
    maxTurns: 1,
    ...(model ? { model } : {}),
    ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
    ...(labels ? { outputFormat: { type: "json_schema", schema: labelSchema(labels) } } : {}),
  };
}

function usageOf(result: ResultMessage): TurnUsage | undefined {
  const usage = result.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(typeof usage.cache_read_input_tokens === "number" ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(typeof usage.cache_creation_input_tokens === "number" ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
    ...(typeof result.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
  };
}

function labelOf(structured: unknown, labels: string[] | undefined): string | undefined {
  if (!labels) return undefined;
  const raw = typeof structured === "string" ? structured : typeof structured === "object" && structured !== null ? (structured as { label?: unknown }).label : undefined;
  return typeof raw === "string" && labels.includes(raw) ? raw : undefined;
}

export async function complete(
  request: CompletionRequest,
  config: ClaudeConfig,
  env: DriverEnv,
  queryFn: QueryFn,
  binaryPath: string | undefined,
): Promise<CompletionResult> {
  const started = Date.now();
  const abort = new AbortController();
  const labels = request.labels && request.labels.length > 0 ? request.labels : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`timeout: claude completion exceeded ${request.timeoutMs}ms`));
    }, request.timeoutMs);
    const onAbort = (): void => {
      abort.abort();
      reject(new Error("aborted: claude completion cancelled"));
    };
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort);
  });

  const run = async (): Promise<CompletionResult> => {
    const query = queryFn({ prompt: request.prompt, options: buildCompletionOptions(request, config, binaryPath, abort, env.log) });
    let model: string | undefined;
    for await (const message of query as AsyncIterable<ClaudeMessage>) {
      if (message.type === "system" && message.subtype === "init") {
        const reported = (message as { model?: unknown }).model;
        if (typeof reported === "string") model = reported;
        continue;
      }
      if (message.type !== "result") continue;
      const result = message as ResultMessage & { structured_output?: unknown };
      if (result.subtype !== "success" || result.is_error) {
        throw new Error(`claude completion failed: ${result.errors?.join("; ") ?? result.result ?? result.subtype}`);
      }
      const label = labelOf(result.structured_output, labels);
      const usage = usageOf(result);
      const text = label ?? result.result ?? (result.structured_output !== undefined ? JSON.stringify(result.structured_output) : "");
      return {
        text,
        ...(label !== undefined ? { label } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(usage ? { usage } : {}),
        elapsedMs: Date.now() - started,
      };
    }
    throw new Error("claude completion ended without a result");
  };

  const running = run();
  // whichever side loses the race must not surface as an unhandled rejection
  running.catch(() => undefined);
  cancelled.catch(() => undefined);
  try {
    return await Promise.race([running, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
  }
}
