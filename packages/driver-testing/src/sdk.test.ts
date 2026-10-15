import { describe, expect, it } from "vitest";
import { Recorder } from "./recorder.ts";
import { parseTranscript } from "./frames.ts";
import { queryOptionsFrame, recordQuery, replayQuery } from "./sdk.ts";
import { Replay } from "./transport.ts";

const lines = (...frames: unknown[]): string => frames.map((frame) => JSON.stringify(frame)).join("\n");
const start = { t: "start", provider: "claude", version: "0.3.296", scenario: "unit", synthetic: true };

async function* oneMessage(text: string): AsyncGenerator<unknown> {
  yield { type: "user", message: { role: "user", content: text } };
}

async function drain(iterable: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length === count) break;
  }
  return out;
}

describe("queryOptionsFrame", () => {
  it("drops env, abortController and stderr and marks canUseTool", () => {
    expect(queryOptionsFrame({ cwd: "/r", env: { SECRET: "x" }, abortController: new AbortController(), stderr: () => undefined, canUseTool: () => undefined, model: "m" })).toEqual({ cwd: "/r", model: "m", canUseTool: true });
  });
});

describe("replayQuery", () => {
  it("matches the call options and each prompt message, then yields the SDK messages", async () => {
    const replay = Replay.fromString(
      lines(
        start,
        { t: "expect_out", match: { kind: "query", options: { cwd: "/repo", permissionMode: "default" } } },
        { t: "expect_out", match: { kind: "prompt", message: { message: { content: "/hello/" } } } },
        { t: "in", frame: { type: "system", subtype: "init", session_id: "s-1" } },
        { t: "in", frame: { type: "result", subtype: "success" } },
        { t: "exit", code: 0 },
      ),
    );
    const query = replayQuery(replay);
    const q = query({ prompt: oneMessage("say hello"), options: { cwd: "/repo", permissionMode: "default", env: { A: "b" } } });
    expect(await drain(q, 5)).toEqual([
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "result", subtype: "success" },
    ]);
    replay.assertDrained();
  });

  it("fails the iterator with the diff when the options differ", async () => {
    const replay = Replay.fromString(lines(start, { t: "expect_out", match: { kind: "query", options: { permissionMode: "plan" } } }));
    expect(() => replayQuery(replay)({ prompt: "x", options: { permissionMode: "default" } })).toThrow(/permissionMode: expected "plan", got "default"/);
  });

  it("answers control calls with control_result and invokes canUseTool callbacks", async () => {
    const replay = Replay.fromString(
      lines(
        start,
        { t: "expect_out", match: { kind: "query" } },
        { t: "expect_out", match: { kind: "prompt", message: "go" } },
        { t: "in", frame: { callback: "canUseTool", toolName: "Bash", input: { command: "ls" }, toolUseID: "tu1" } },
        { t: "expect_out", match: { kind: "permission", toolName: "Bash", result: { behavior: "allow" } } },
        { t: "in", frame: { type: "assistant" } },
        { t: "expect_out", match: { kind: "control", method: "setModel", args: ["opus"] } },
        { t: "expect_out", match: { kind: "control", method: "getContextUsage" } },
        { t: "in", frame: { control_result: { totalTokens: 7 } } },
        { t: "exit", code: 0 },
      ),
    );
    const q = replayQuery(replay)({
      prompt: "go",
      options: { canUseTool: async (_name: string, input: unknown) => ({ behavior: "allow", updatedInput: input }) },
    });
    const messages = await drain(q, 1);
    expect(messages).toEqual([{ type: "assistant" }]);
    await q.setModel("opus");
    await expect(q.getContextUsage()).resolves.toEqual({ totalTokens: 7 });
    replay.assertDrained();
  });

  it("turns a non-zero exit into an iterator error", async () => {
    const replay = Replay.fromString(lines(start, { t: "expect_out", match: { kind: "query" } }, { t: "exit", code: 2 }));
    const q = replayQuery(replay)({ prompt: "x" });
    await expect(drain(q, 1)).rejects.toThrow(/exited with code 2/);
  });
});

describe("recordQuery", () => {
  it("records the call, prompt messages, control results and messages; the recording replays", async () => {
    const source = Replay.fromString(
      lines(
        start,
        { t: "expect_out", match: { kind: "query" } },
        { t: "expect_out", match: { kind: "prompt", message: "hi" } },
        { t: "in", frame: { type: "result" } },
        { t: "expect_out", match: { kind: "control", method: "supportedModels" } },
        { t: "in", frame: { control_result: [{ value: "m" }] } },
        { t: "exit", code: 0 },
      ),
    );
    const recorder = new Recorder({ provider: "claude", version: "0.3.296", scenario: "rt" });
    const real = replayQuery(source);
    const recorded = recordQuery(real as never, recorder);
    const q = recorded({ prompt: "hi", options: { cwd: "/r", env: { TOKEN: "t" } } }) as unknown as AsyncIterable<unknown> & { supportedModels(): Promise<unknown> };
    const iterator = q[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "result" });
    await q.supportedModels();
    expect((await iterator.next()).done).toBe(true);

    const frames = parseTranscript(recorder.toString()).processes[0]!.frames;
    expect(frames.slice(0, 3)).toEqual([
      { t: "expect_out", match: { kind: "query", options: { cwd: "/r" } } },
      { t: "expect_out", match: { kind: "prompt", message: "hi" } },
      { t: "in", frame: { type: "result" } },
    ]);
    expect(frames.some((f) => f.t === "expect_out" && JSON.stringify(f.match).includes("supportedModels"))).toBe(true);
    expect(frames.some((f) => f.t === "in" && JSON.stringify(f.frame).includes("control_result"))).toBe(true);
  });
});
