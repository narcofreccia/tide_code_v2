import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CompletionRequest, DriverEnv } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import type { PromptFile } from "./types.ts";
import { DENY_ALL } from "./complete.ts";
import { INSTRUCTION_KEY, OpencodeInstance } from "./instance.ts";
import type { WireMessage } from "./wire.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

/** Answers every prompt with one assistant message, or never goes idle when `hang` is set. */
class JudgeApi extends FakeOpencodeApi {
  reply: WireMessage = {
    id: "msg_a1",
    type: "assistant",
    model: { providerID: "opencode", id: "small" },
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "approve\n" },
      { type: "text", text: "looks safe" },
    ],
    tokens: { input: 120, output: 8, reasoning: 2, cache: { read: 40, write: 0 } },
    cost: 0.0012,
  };
  hang = false;
  #release: (() => void) | undefined;

  override async prompt(input: { sessionId: string; text: string; files?: PromptFile[]; delivery?: "steer" | "queue" }): Promise<{ id?: string } | undefined> {
    const admitted = await super.prompt(input);
    this.messageLog.push(this.reply, { id: "msg_i1", type: "idle", outcome: "succeeded" });
    return admitted;
  }

  override async waitIdle(input: { sessionId: string }): Promise<void> {
    await super.waitIdle(input);
    if (this.hang) await new Promise<void>((resolve) => (this.#release = resolve));
  }

  override async removeSession(input: { sessionId: string }): Promise<void> {
    await super.removeSession(input);
    this.#release?.();
  }
}

function harness(config: { defaultModel?: string } = {}): { instance: OpencodeInstance; api: JudgeApi } {
  const api = new JudgeApi();
  api.sessionId = "ses_judge";
  const instance = new OpencodeInstance({ serverUrl: "http://127.0.0.1:4096", apiImpl: api, ...config }, env);
  return { instance, api };
}

const request: CompletionRequest = { system: "You are a judge.", prompt: "Is this safe?", model: "opencode/small", timeoutMs: 5_000, cwd: "/scratch" };

describe("OpencodeInstance.complete", () => {
  it("advertises one-shot completions", async () => {
    const { instance } = harness();
    expect((await instance.status()).caps.oneShot).toBe(true);
    await instance.dispose();
  });

  it("runs on a deny-all session with the model and system instruction, returns the last assistant text, and removes the session", async () => {
    const { instance, api } = harness();
    const result = await instance.complete(request);

    expect(api.created).toEqual([{ directory: "/scratch", title: "tide judge", model: { providerID: "opencode", id: "small" }, permissions: DENY_ALL, metadata: { tideOneShot: true } }]);
    expect(DENY_ALL).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(api.instructions).toEqual([{ key: INSTRUCTION_KEY, value: "You are a judge." }]);
    expect(api.prompts.map((p) => [p.sessionId, p.text])).toEqual([["ses_judge", "Is this safe?"]]);
    expect(api.waits).toEqual(["ses_judge"]);
    expect(api.removed).toEqual(["ses_judge"]);

    expect(result.text).toBe("approve\nlooks safe");
    expect(result.label).toBeUndefined();
    expect(result.model).toBe("opencode/small");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, costUsd: 0.0012 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    await instance.dispose();
  });

  it("uses the configured default model, and omits the model when none parses", async () => {
    const withDefault = harness({ defaultModel: "opencode/big-pickle" });
    const { model: _model, ...noModel } = request;
    await withDefault.instance.complete(noModel);
    expect(withDefault.api.created[0]?.model).toEqual({ providerID: "opencode", id: "big-pickle" });

    const bare = harness();
    await bare.instance.complete({ ...request, model: "nope" });
    expect(bare.api.created[0]).not.toHaveProperty("model");
  });

  it("omits usage when the message carries no tokens", async () => {
    const { instance, api } = harness();
    api.reply = { id: "msg_a1", type: "assistant", content: [{ type: "text", text: "deny" }] };
    const result = await instance.complete(request);
    expect(result).toMatchObject({ text: "deny" });
    expect(result.usage).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it("rejects with the error when the assistant produced no text, still removing the session", async () => {
    const { instance, api } = harness();
    api.reply = { id: "msg_a1", type: "assistant", content: [], error: { message: "provider auth failed" } };
    await expect(instance.complete(request)).rejects.toThrow("provider auth failed");
    expect(api.removed).toEqual(["ses_judge"]);
  });

  it("times out with a `timeout` error, interrupts and removes the session", async () => {
    const { instance, api } = harness();
    api.hang = true;
    await expect(instance.complete({ ...request, timeoutMs: 20 })).rejects.toThrow(/^timeout/);
    expect(api.interrupts).toBe(1);
    expect(api.removed).toEqual(["ses_judge"]);
  });

  it("rejects when the signal aborts, removing the session", async () => {
    const { instance, api } = harness();
    api.hang = true;
    const controller = new AbortController();
    const pending = instance.complete({ ...request, signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toThrow(/^aborted/);
    expect(api.removed).toEqual(["ses_judge"]);
  });
});
