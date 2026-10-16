import type { CompletionRequest, CompletionResult } from "@tide/contracts";
import type { PiConfig, SpawnLike } from "./types.ts";

const STDERR_TAIL = 500;

/**
 * Argument vector for a one-shot, tools-off `pi -p` call. Everything that could make pi
 * act like an agent (tools, extensions, skills, AGENTS.md/CLAUDE.md, session file, thinking)
 * is off; the prompt itself arrives on stdin.
 */
export function buildCompleteArgs(request: CompletionRequest, config: PiConfig): string[] {
  const args = ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--thinking", "off"];
  const model = request.model ?? config.defaultModel;
  if (model) args.push("--model", model);
  args.push("--system-prompt", request.system);
  return args;
}

/** Runs `pi -p` once. Rejects `timeout …` on deadline/abort, or with the stderr tail on a non-zero exit. */
export function runComplete(binary: string, request: CompletionRequest, config: PiConfig, spawn: SpawnLike): Promise<CompletionResult> {
  const started = Date.now();
  const child = spawn(binary, buildCompleteArgs(request, config), {
    cwd: request.cwd,
    env: { ...process.env, ...config.env },
  });
  return new Promise<CompletionResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const abort = (reason: string) => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`timeout: ${reason}`));
      });
    };
    const timer = setTimeout(() => abort(`pi did not answer within ${request.timeoutMs}ms`), request.timeoutMs);
    if (request.signal?.aborted) abort("aborted");
    else request.signal?.addEventListener("abort", () => abort("aborted"));

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", ((error: Error) => finish(() => reject(error))) as (...args: never[]) => void);
    child.once("exit", ((code: number | null) => {
      // let trailing stdout/stderr chunks flush before reading them
      setImmediate(() =>
        finish(() => {
          if (code !== 0) {
            reject(new Error(`pi exited with ${code ?? "a signal"}: ${stderr.trim().slice(-STDERR_TAIL)}`));
            return;
          }
          const text = stdout.trim();
          const label = request.labels?.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
          const model = request.model ?? config.defaultModel;
          resolve({ text, ...(label !== undefined ? { label } : {}), ...(model ? { model } : {}), elapsedMs: Date.now() - started });
        }),
      );
    }) as (...args: never[]) => void);

    child.stdin?.write(request.prompt);
    child.stdin?.end();
  });
}
