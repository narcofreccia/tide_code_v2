import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions, TurnUsage } from "@tide/contracts";
import { AsyncQueue, deferred } from "./async-queue.ts";
import type { CostState, CostStatesFn } from "./cost-state.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import { ClaudeSession } from "./session.ts";
import type { QueryFn } from "./types.ts";

/** A scripted CLI: answers each prompt with init + result; `crash()` ends its stream with an error. */
class ScriptedQuery {
  readonly messages = new AsyncQueue<ClaudeMessage>();
  readonly options: Record<string, unknown>;
  #crash = false;
  constructor(prompt: AsyncIterable<unknown>, options: Record<string, unknown>, reply: (query: ScriptedQuery) => void) {
    this.options = options;
    void (async () => {
      for await (const _message of prompt) reply(this);
    })();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeMessage, void> {
    yield* this.messages.drain();
    if (this.#crash) throw new Error("cli gone");
  }
  crash(): void {
    this.#crash = true;
    this.messages.close();
  }
}

const tokens = (input: number) => ({ inputTokens: input, outputTokens: input, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

function harness(costs: number[], states: CostState[] | undefined, overrides: Partial<OpenSessionOptions> = {}) {
  const queries: ScriptedQuery[] = [];
  const reads: { sessionId: string; cwd: string }[] = [];
  const lost = deferred<void>();
  const env: DriverEnv = { dataDir: tmpdir(), log: (line) => (line.includes("stream failed between turns") ? lost.resolve() : undefined) };
  let turn = 0;
  const reply = (query: ScriptedQuery) => {
    const cost = costs[turn++] ?? 0;
    query.messages.push({ type: "system", subtype: "init", session_id: "s1" } as ClaudeMessage);
    // modelUsage grows with cost, so token deltas follow the same baseline as cost
    query.messages.push({ type: "result", subtype: "success", session_id: "s1", is_error: false, total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { m: tokens(Math.round(cost * 1000)) } } as ClaudeMessage);
  };
  const queryFn: QueryFn = ({ prompt, options }) => {
    const query = new ScriptedQuery(prompt as AsyncIterable<unknown>, options ?? {}, reply);
    queries.push(query);
    return query as unknown as ReturnType<QueryFn>;
  };
  const costStatesImpl: CostStatesFn = async (sessionId, options) => {
    reads.push({ sessionId, cwd: options.cwd });
    return states;
  };
  const options: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...overrides };
  const session = new ClaudeSession({ costStatesImpl }, env, options, queryFn);
  return { session, queries, reads, lost: lost.promise };
}

async function usageOf(stream: AsyncIterable<NormalizedEvent>): Promise<TurnUsage | undefined> {
  let usage: TurnUsage | undefined;
  for await (const event of stream) if (event.type === "usage" && event.usage) usage = event.usage;
  return usage;
}

const state = (cost: number): CostState => ({ cost, tokens: { input: Math.round(cost * 1000), output: Math.round(cost * 1000), cacheRead: 0, cacheWrite: 0 } });

describe("ClaudeSession usage across queries", () => {
  it("a brand-new session counts from zero and never reads a transcript", async () => {
    const h = harness([1.5, 2], undefined);
    expect(await usageOf(h.session.send({ text: "a" }))).toMatchObject({ costUsd: 1.5, inputTokens: 1500 });
    expect(await usageOf(h.session.send({ text: "b" }))).toMatchObject({ costUsd: 0.5, inputTokens: 500 });
    expect(h.reads).toEqual([]);
    await h.session.close();
  });

  it("a resume in a new process subtracts the transcript's restored total", async () => {
    const h = harness([157.241, 158], [state(156.75), state(157.623)], { resume: "s1" });
    const first = await usageOf(h.session.send({ text: "a" }));
    expect(first?.costUsd).toBeCloseTo(0.491, 6);
    expect(first?.inputTokens).toBe(491);
    expect((await usageOf(h.session.send({ text: "b" })))?.costUsd).toBeCloseTo(0.759, 6);
    expect(h.reads).toEqual([{ sessionId: "s1", cwd: "/repo" }]);
    expect(h.queries[0]?.options["resume"]).toBe("s1");
    await h.session.close();
  });

  it("a fork reads the source's transcript", async () => {
    const h = harness([10.2], [state(10)], { forkFrom: "src" });
    expect((await usageOf(h.session.send({ text: "a" })))?.costUsd).toBeCloseTo(0.2, 6);
    expect(h.reads).toEqual([{ sessionId: "src", cwd: "/repo" }]);
    await h.session.close();
  });

  it("an unreadable transcript omits the first cost and counts later turns exactly", async () => {
    const h = harness([50, 51], undefined, { resume: "s1" });
    const first = await usageOf(h.session.send({ text: "a" }));
    expect(first).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect((await usageOf(h.session.send({ text: "b" })))?.costUsd).toBeCloseTo(1, 6);
    await h.session.close();
  });

  it("the tracker survives a query teardown: the resumed query does not count the old turns again", async () => {
    // the killed process saved no cost-state: the CLI restores the older one (1.0)
    const h = harness([1.0, 1.5, 1.2], [state(1.0)]);
    await usageOf(h.session.send({ text: "a" }));
    await usageOf(h.session.send({ text: "b" }));
    h.queries[0]?.crash();
    await h.lost;
    const third = await usageOf(h.session.send({ text: "c" }));
    expect(h.queries).toHaveLength(2);
    expect(h.queries[1]?.options["resume"]).toBe("s1");
    expect(third?.costUsd).toBeCloseTo(0.2, 6);
    await h.session.close();
  });

  it("after a teardown whose process saved its totals, the tracker's last totals are the baseline", async () => {
    const h = harness([1.0, 1.5, 1.8], [state(1.0), state(1.5)]);
    await usageOf(h.session.send({ text: "a" }));
    await usageOf(h.session.send({ text: "b" }));
    h.queries[0]?.crash();
    await h.lost;
    expect((await usageOf(h.session.send({ text: "c" })))?.costUsd).toBeCloseTo(0.3, 6);
    await h.session.close();
  });
});
