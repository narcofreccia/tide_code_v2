import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CompletionRequest, DriverEnv } from "@tide/contracts";
import { complete } from "./complete.ts";
import { ClaudeInstance } from "./instance.ts";
import { CLAUDE_CAPS } from "./status.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import type { QueryFn } from "./types.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
const base: CompletionRequest = { system: "classify", prompt: "is this good?", timeoutMs: 5_000, cwd: tmpdir() };

function scripted(messages: ClaudeMessage[]): { queryFn: QueryFn; calls: { prompt: unknown; options: Record<string, unknown> }[] } {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const message of messages) yield message;
      },
    } as unknown as ReturnType<QueryFn>;
  };
  return { queryFn, calls };
}

const init = { type: "system", subtype: "init", session_id: "s", model: "claude-haiku-test" } as ClaudeMessage;
function result(extra: Record<string, unknown>): ClaudeMessage {
  return { type: "result", subtype: "success", session_id: "s", is_error: false, usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.002, ...extra } as ClaudeMessage;
}

describe("claude complete()", () => {
  it("runs a stripped, tools-off, single-turn query", async () => {
    const { queryFn, calls } = scripted([init, result({ result: "yes" })]);
    await complete({ ...base, model: "haiku" }, {}, env, queryFn, "/bin/claude");
    const [call] = calls;
    expect(call?.prompt).toBe("is this good?");
    expect(call?.options).toMatchObject({
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      systemPrompt: "classify",
      model: "haiku",
      cwd: base.cwd,
      pathToClaudeCodeExecutable: "/bin/claude",
    });
    expect(call?.options["outputFormat"]).toBeUndefined();
    expect(call?.options["abortController"]).toBeInstanceOf(AbortController);
  });

  it("returns the result text, model and usage without a schema", async () => {
    const { queryFn } = scripted([init, result({ result: "positive" })]);
    const out = await complete(base, {}, env, queryFn, undefined);
    expect(out).toMatchObject({ text: "positive", model: "claude-haiku-test", usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.002 } });
    expect(out.label).toBeUndefined();
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("constrains to labels and reads the label from structured_output", async () => {
    const { queryFn, calls } = scripted([init, result({ result: "", structured_output: { label: "negative" } })]);
    const out = await complete({ ...base, labels: ["positive", "negative"], maxOutputTokens: 64 }, {}, env, queryFn, undefined);
    expect(out.label).toBe("negative");
    expect(out.text).toBe("negative");
    const options = calls[0]?.options ?? {};
    expect(options["outputFormat"]).toMatchObject({ type: "json_schema", schema: { properties: { label: { enum: ["positive", "negative"] } } } });
    expect((options["env"] as Record<string, string>)["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]).toBe("64");
  });

  it("ignores a structured answer outside the labels", async () => {
    const { queryFn } = scripted([result({ result: "maybe", structured_output: { label: "maybe" } })]);
    const out = await complete({ ...base, labels: ["yes", "no"] }, {}, env, queryFn, undefined);
    expect(out.label).toBeUndefined();
    expect(out.text).toBe("maybe");
  });

  it("rejects on an error result", async () => {
    const { queryFn } = scripted([result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })]);
    await expect(complete(base, {}, env, queryFn, undefined)).rejects.toThrow(/boom/);
  });

  it("rejects with a timeout error and aborts the query", async () => {
    let signal: AbortSignal | undefined;
    const queryFn: QueryFn = ({ options }) => {
      signal = (options?.["abortController"] as AbortController).signal;
      return {
        [Symbol.asyncIterator]: async function* () {
          await new Promise(() => undefined);
        },
      } as unknown as ReturnType<QueryFn>;
    };
    await expect(complete({ ...base, timeoutMs: 10 }, {}, env, queryFn, undefined)).rejects.toThrow(/^timeout/);
    expect(signal?.aborted).toBe(true);
  });

  it("rejects when the caller's signal aborts", async () => {
    const queryFn: QueryFn = () =>
      ({
        [Symbol.asyncIterator]: async function* () {
          await new Promise(() => undefined);
        },
      }) as unknown as ReturnType<QueryFn>;
    const controller = new AbortController();
    const pending = complete({ ...base, signal: controller.signal }, {}, env, queryFn, undefined);
    controller.abort();
    await expect(pending).rejects.toThrow(/^aborted/);
  });

  it("is advertised and wired on the instance", async () => {
    expect(CLAUDE_CAPS.oneShot).toBe(true);
    const { queryFn, calls } = scripted([result({ result: "ok" })]);
    const instance = new ClaudeInstance({ binaryPath: "/nonexistent/claude" }, env, queryFn);
    const out = await instance.complete(base);
    expect(out.text).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
