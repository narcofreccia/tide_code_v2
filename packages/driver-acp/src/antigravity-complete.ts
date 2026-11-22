import type { CompletionRequest, CompletionResult, DriverEnv, TurnUsage } from "@tide/contracts";
import { agentEnv, nodeSpawn } from "./spawn.ts";
import type { AcpConfig, AcpDeps, TimerLike } from "./types.ts";

const REAL_TIMERS: TimerLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Antigravity's `--json-schema` expects a JSON Schema object; wrap classification labels. */
export function labelSchema(labels: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { label: { type: "string", enum: labels } },
    required: ["label"],
    additionalProperties: false,
  };
}

/** Extracts text, label, model and optional usage from `agy --print --output-format json` stdout. */
export function parseAntigravityPrintOutput(
  raw: string,
  labels: string[] | undefined,
): { text: string; label?: string; model?: string; usage?: TurnUsage } {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Some CLI builds log non-JSON preamble lines before the final JSON object.
    const lastLine = trimmed.split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"));
    if (lastLine !== undefined) {
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        parsed = undefined;
      }
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    const matched = matchLabel(trimmed, labels);
    return { text: matched ?? trimmed, ...(matched !== undefined ? { label: matched } : {}) };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["is_error"] === true || obj["error"] !== undefined) {
    const err = typeof obj["error"] === "string" ? obj["error"] : typeof obj["result"] === "string" ? obj["result"] : JSON.stringify(obj["error"] ?? "error");
    throw new Error(`antigravity completion failed: ${err}`);
  }
  const structured = obj["structured_output"] ?? obj["structuredOutput"];
  const rawText =
    typeof obj["result"] === "string"
      ? obj["result"]
      : typeof obj["response"] === "string"
        ? obj["response"]
        : typeof obj["text"] === "string"
          ? obj["text"]
          : typeof obj["content"] === "string"
            ? obj["content"]
            : structured !== undefined
              ? JSON.stringify(structured)
              : trimmed;
  const label = extractLabel(structured, labels) ?? extractLabel(tryJson(rawText), labels) ?? matchLabel(rawText, labels);
  const model = typeof obj["model"] === "string" && obj["model"] !== "" ? obj["model"] : undefined;
  const usage = extractUsage(obj["usage"]);
  return {
    text: label ?? rawText.trim(),
    ...(label !== undefined ? { label } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function extractLabel(value: unknown, labels: string[] | undefined): string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && typeof (value as { label?: unknown }).label === "string"
        ? (value as { label: string }).label
        : undefined;
  return raw !== undefined ? matchLabel(raw, labels) : undefined;
}

function matchLabel(text: string, labels: string[] | undefined): string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const clean = text.trim().replace(/^"|"$/g, "");
  return labels.find((candidate) => candidate.toLowerCase() === clean.toLowerCase());
}

function extractUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const input = num(u["inputTokens"] ?? u["input_tokens"] ?? u["promptTokens"]);
  const output = num(u["outputTokens"] ?? u["output_tokens"] ?? u["candidatesTokens"]);
  const thought = num(u["thoughtTokens"] ?? u["thought_tokens"] ?? u["thoughtsTokens"]) ?? 0;
  const cacheRead = num(u["cachedReadTokens"] ?? u["cache_read_input_tokens"] ?? u["cachedContentTokens"]);
  const cacheWrite = num(u["cachedWriteTokens"] ?? u["cache_creation_input_tokens"]);
  const costUsd = num(u["costUsd"] ?? u["total_cost_usd"]);
  if (input === undefined && output === undefined && costUsd === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: (output ?? 0) + thought,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One-shot completion via `agy --print --output-format json --disable-slash-commands --effort low`.
 * Runs non-interactively in `request.cwd` with strict timeout and abort handling.
 */
export async function completeAntigravity(
  config: AcpConfig,
  env: DriverEnv,
  request: CompletionRequest,
  deps: Partial<AcpDeps> = {},
): Promise<CompletionResult> {
  const started = Date.now();
  const spawnFn = deps.spawn ?? nodeSpawn;
  const timers = deps.timers ?? REAL_TIMERS;
  const labels = request.labels && request.labels.length > 0 ? request.labels : undefined;
  const model = request.model ?? config.defaultModel;
  const fullPrompt = request.system.trim() !== "" ? `${request.system.trim()}\n\n${request.prompt}` : request.prompt;
  const args = [
    "--print",
    "--output-format",
    "json",
    "--disable-slash-commands",
    "--effort",
    "low",
    ...(model ? ["--model", model] : []),
    ...(labels ? ["--json-schema", JSON.stringify(labelSchema(labels))] : []),
  ];

  const child = spawnFn(config.command, args, { cwd: request.cwd, env: agentEnv(config, env) });
  let stdout = "";
  let stderr = "";
  let stdoutDone = child.stdout === null;
  let exitDone = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  let timer: unknown;
  let settled = false;
  const stopChild = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const maybeFinish = (): void => {
        if (!exitDone || !stdoutDone) return;
        if (exitCode === 0) finish();
        else {
          const detail = stderr.trim().split(/\r?\n/).at(-1) ?? "";
          finish(new Error(`antigravity completion exited (${exitCode ?? exitSignal ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        }
      };
      const onAbort = (): void => {
        stopChild();
        finish(new Error("aborted: antigravity completion cancelled"));
      };
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      request.signal?.addEventListener("abort", onAbort);
      timer = timers.setTimeout(() => {
        stopChild();
        finish(new Error(`timeout: antigravity completion exceeded ${request.timeoutMs}ms`));
      }, request.timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      child.stdout?.on("end", () => {
        stdoutDone = true;
        maybeFinish();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });

      child.once("error", ((error: Error) => finish(error)) as never);
      child.once("exit", ((code: number | null, signal: string | null) => {
        exitDone = true;
        exitCode = code;
        exitSignal = signal;
        maybeFinish();
      }) as never);

      try {
        child.stdin?.write(fullPrompt);
        child.stdin?.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }

  const parsed = parseAntigravityPrintOutput(stdout, labels);
  const usedModel = parsed.model ?? model;
  return {
    text: parsed.text,
    ...(parsed.label !== undefined ? { label: parsed.label } : {}),
    ...(usedModel !== undefined ? { model: usedModel } : {}),
    ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
    elapsedMs: Date.now() - started,
  };
}
