import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { AsyncQueue } from "./async-queue.ts";
import { markResumeRefused } from "./resume-refused.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import { ClaudeSession } from "./session.ts";
import type { QueryFn } from "./types.ts";

const GONE = "3f1c2a9e-0000-4000-8000-000000000001";
/**
 * Recorded live (Claude Code 2.1.322, `claude -p --resume <unknown uuid> --output-format
 * stream-json --verbose`; the SDK 0.3.296 streaming-input query yields the same frame): the only
 * message before the CLI exits 1. Usage trimmed.
 */
const REFUSED_RESULT = {
  type: "result",
  subtype: "error_during_execution",
  duration_ms: 0,
  duration_api_ms: 0,
  is_error: true,
  num_turns: 0,
  stop_reason: null,
  session_id: GONE,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
  permission_denials: [],
  uuid: "174b2717-b4d6-4f58-b025-b91940467483",
  errors: [`No conversation found with session ID: ${GONE}`],
} as unknown as ClaudeMessage;
/** What the SDK iterator throws right after that frame (same live run). */
const SDK_THROW = `Claude Code returned an error result: No conversation found with session ID: ${GONE}`;

function session(options: { resume?: string; forkFrom?: string }, frames: (q: AsyncQueue<ClaudeMessage>) => void): { session: ClaudeSession; queries: Record<string, unknown>[] } {
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const queries: Record<string, unknown>[] = [];
  const queryFn: QueryFn = ({ options: opts }) => {
    queries.push(opts ?? {});
    const messages = new AsyncQueue<ClaudeMessage>();
    frames(messages);
    return { async *[Symbol.asyncIterator]() { yield* messages.drain(); }, async interrupt() {} } as unknown as ReturnType<QueryFn>;
  };
  return { session: new ClaudeSession({}, env, { threadId: "t1", cwd: tmpdir(), mode: "approval-required", interaction: "default", mcpServers: [], ...options }, queryFn), queries };
}

async function settledOf(stream: AsyncIterable<NormalizedEvent>): Promise<Extract<NormalizedEvent, { type: "settled" }> | undefined> {
  let settled: Extract<NormalizedEvent, { type: "settled" }> | undefined;
  for await (const event of stream) if (event.type === "settled") settled = event;
  return settled;
}

describe("Claude resume refused (R19 L5)", () => {
  it("marks the refusal of a resumed session with the resume-refused code, keeping Claude Code's words", async () => {
    const { session: s, queries } = session({ resume: GONE }, (q) => {
      q.push(REFUSED_RESULT);
      q.close();
    });
    const settled = await settledOf(s.send({ text: "hi" }));
    expect(queries[0]?.["resume"]).toBe(GONE);
    expect(settled).toEqual({ type: "settled", status: "error", error: `resume-refused: No conversation found with session ID: ${GONE}` });
    await s.close();
  });

  it("marks the SDK's throw too, when the iterator fails before the result frame is read", async () => {
    const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
    const queryFn: QueryFn = () =>
      ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(SDK_THROW)) }),
        async interrupt() {},
      }) as unknown as ReturnType<QueryFn>;
    const s = new ClaudeSession({}, env, { threadId: "t1", cwd: tmpdir(), mode: "approval-required", interaction: "default", mcpServers: [], resume: GONE }, queryFn);
    const settled = await settledOf(s.send({ text: "hi" }));
    expect(settled?.error).toBe(`resume-refused: No conversation found with session ID: ${GONE}`);
    await s.close();
  });

  it("leaves the same words alone on a query that did not resume (a fork source is not this session)", async () => {
    const { session: s } = session({ forkFrom: GONE }, (q) => {
      q.push(REFUSED_RESULT);
      q.close();
    });
    const settled = await settledOf(s.send({ text: "hi" }));
    expect(settled?.error).toBe(`No conversation found with session ID: ${GONE}`);
    await s.close();
  });

  it("leaves any other error of a resumed session alone", () => {
    expect(markResumeRefused("API Error: 529 overloaded", GONE)).toBe("API Error: 529 overloaded");
    expect(markResumeRefused(`No conversation found with session ID: ${GONE}`, undefined)).toBe(`No conversation found with session ID: ${GONE}`);
    expect(markResumeRefused(`resume-refused: No conversation found with session ID: ${GONE}`, GONE)).toBe(`resume-refused: No conversation found with session ID: ${GONE}`);
  });
});
