import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, TurnUsage } from "@tide/contracts";
import { type CostState, projectSlug, readCostStateFile, readCostStates } from "../src/cost-state.ts";
import { ClaudeNormalizer } from "../src/normalize.ts";
import type { ClaudeMessage, ResultMessage } from "../src/sdk-shapes.ts";
import { UsageTracker } from "../src/usage.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): ClaudeMessage[] {
  return readFileSync(join(fixtures, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaudeMessage);
}

const results = (name: string): ResultMessage[] => load(name).filter((m): m is ResultMessage => m.type === "result");
const states = (name: string): Promise<CostState[]> => readCostStateFile(join(fixtures, `${name}.jsonl`));

/** A query starting on `tracker`, resuming `source` with the given transcript reader result. */
async function begin(tracker: UsageTracker, source: string | undefined, read: CostState[] | undefined): Promise<void> {
  tracker.beginQuery(source, async () => read);
  await tracker.ready();
}

const tokens = (usage: TurnUsage) => [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];

describe("usage from recorded sessions (CLI 2.1.327, haiku)", () => {
  it("two turns on one query: each result's cumulative modelUsage minus the previous", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, undefined, undefined);
    const [first, second] = results("usage-two-turns").map((r) => tracker.result(r));
    expect(tokens(first!)).toEqual([1175, 17, 11617, 14488]);
    expect(first?.costUsd).toBeCloseTo(0.00313977, 8);
    // turn two equals that result's own per-turn `usage` (main loop only, no sub-agents here)
    expect(tokens(second!)).toEqual([2, 3, 15301, 12968]);
    expect(second?.costUsd).toBeCloseTo(0.00274831, 8);
  });

  it("a resume in a new process starts from the transcript's cost-state, not from zero", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, "239c9196-453d-4f42-9728-b1b97f749919", await states("usage-transcript-after-two"));
    const [third] = results("usage-resume").map((r) => tracker.result(r));
    // the result reports 0.00666896, the restored 0.00588808 included
    expect(third?.costUsd).toBeCloseTo(0.00078088, 8);
    expect(tokens(third!)).toEqual([2, 3, 26118, 2590]);
  });

  it("a resume on the same tracker (query rebuilt after a teardown) gives the same delta", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, undefined, undefined);
    for (const r of results("usage-two-turns")) tracker.result(r);
    await begin(tracker, "239c9196-453d-4f42-9728-b1b97f749919", await states("usage-transcript-after-two"));
    expect(tracker.result(results("usage-resume")[0]!).costUsd).toBeCloseTo(0.00078088, 8);
  });

  it("a fork continues from the source's latest total", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, "239c9196-453d-4f42-9728-b1b97f749919", await states("usage-transcript-after-resume"));
    const [fork] = results("usage-fork").map((r) => tracker.result(r));
    expect(fork?.costUsd).toBeCloseTo(0.00037732, 8);
    expect(tokens(fork!)).toEqual([2, 3, 28282, 464]);
  });

  it("a background sub-agent's tokens land on the harness turn its report wakes", async () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: true });
    const usage = load("usage-background").flatMap((m) => normalizer.next(m)).flatMap((e: NormalizedEvent) => (e.type === "usage" && e.usage ? [e.usage] : []));
    expect(usage).toHaveLength(2);
    // result.usage of the harness turn says 4/3 (main loop only); modelUsage adds the sub-agent
    expect(tokens(usage[1]!)).toEqual([8, 172, 47161, 21137]);
    expect(usage[1]?.costUsd).toBeCloseTo(0.00324516, 8);
  });
});

describe("usage edge cases", () => {
  const result = (cost: number | undefined, mu: number | undefined, usage = { input_tokens: 1, output_tokens: 2 }, extra: Partial<ResultMessage> = {}): ResultMessage => ({
    type: "result",
    subtype: "success",
    session_id: "s",
    is_error: false,
    usage,
    ...(cost !== undefined ? { total_cost_usd: cost } : {}),
    ...(mu !== undefined ? { modelUsage: { m: { inputTokens: mu, outputTokens: mu, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } } : {}),
    ...extra,
  });

  it("synthetic-fresh-session: /clear or a fresh session counts from zero", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, undefined, undefined);
    expect(tracker.result(result(0.4, 40))).toMatchObject({ costUsd: 0.4, inputTokens: 40 });
  });

  it("synthetic-mid-session-clear: running totals that go backwards restart from zero", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, undefined, undefined);
    tracker.result(result(3, 300));
    expect(tracker.result(result(0.2, 20))).toMatchObject({ costUsd: 0.2, inputTokens: 20 });
    expect(tracker.result(result(0.5, 50))).toMatchObject({ costUsd: 0.3, inputTokens: 30 });
  });

  it("synthetic-crash: a zeroed result never yields a negative delta and leaves the totals alone", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, undefined, undefined);
    tracker.result(result(3, 300));
    const crash = tracker.result(result(0, undefined, { input_tokens: 0, output_tokens: 0 }, { subtype: "error_during_execution", is_error: true, modelUsage: {} }));
    expect(crash).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tracker.result(result(3.5, 350))).toMatchObject({ costUsd: 0.5, inputTokens: 50 });
  });

  it("synthetic-crash-first: a zeroed first result of a resumed query does not use up the baseline", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, "s", [{ cost: 10 }]);
    expect(tracker.result(result(0, undefined, { input_tokens: 0, output_tokens: 0 }, { modelUsage: {} })).costUsd).toBeUndefined();
    expect(tracker.result(result(10.25, 5)).costUsd).toBeCloseTo(0.25, 8);
  });

  it("synthetic-no-model-usage: tokens come from result.usage as-is, never diffed", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, undefined, undefined);
    expect(tracker.result(result(0.1, undefined, { input_tokens: 10, output_tokens: 4 }))).toEqual({ inputTokens: 10, outputTokens: 4, costUsd: 0.1 });
    expect(tracker.result(result(0.3, undefined, { input_tokens: 10, output_tokens: 4 }))).toEqual({ inputTokens: 10, outputTokens: 4, costUsd: 0.2 });
  });

  it("synthetic-unreadable: a resume whose transcript cannot be read reports no first cost", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, "s", undefined);
    expect(tracker.result(result(80, 900, { input_tokens: 3, output_tokens: 4 }))).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(tracker.result(result(81, 950))).toMatchObject({ costUsd: 1, inputTokens: 50 });
  });

  it("token deltas are clamped at zero when the chosen candidate has more of one counter", async () => {
    const tracker = new UsageTracker();
    await begin(tracker, "s", [{ cost: 1, tokens: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 } }]);
    expect(tracker.result(result(1.5, 100))).toMatchObject({ costUsd: 0.5, inputTokens: 0, outputTokens: 90 });
  });
});

describe("baseline rule on a real resumed thread", () => {
  const series = [31.06, 37.799, 44.719, 63.271, 66.665, 78.046, 83.009, 91.575, 104.731, 113.473, 156.75, 157.623, 162.048, 167.551, 170.311, 177.954, 205.858, 208.496, 208.824, 214.446];
  const cases: [number, number][] = [
    [157.241, 156.75],
    [167.419, 162.048],
    [183.221, 177.954],
  ];
  for (const [reported, baseline] of cases) {
    it(`first result ${reported} after a resume -> baseline ${baseline}`, async () => {
      const tracker = new UsageTracker();
      await begin(tracker, "s", series.map((cost) => ({ cost })));
      const usage = tracker.result({ type: "result", subtype: "success", session_id: "s", is_error: false, total_cost_usd: reported, usage: {} });
      expect(usage.costUsd).toBeCloseTo(reported - baseline, 6);
    });
  }
});

describe("corrected background-subagent fixture", () => {
  it("per-turn usage stays as is; cumulative modelUsage carries each sub-agent into the turn it reports in", () => {
    const normalizer = new ClaudeNormalizer({ partialMessages: true });
    const usage = load("background-subagent").flatMap((m) => normalizer.next(m)).flatMap((e) => (e.type === "usage" && e.usage ? [e.usage] : []));
    expect(usage.map((u) => [u.inputTokens, u.outputTokens])).toEqual([
      [100, 200],
      [450, 900],
      [400, 800],
      [300, 600],
    ]);
    expect(usage.map((u) => u.costUsd)).toEqual([0.05, 0.1, 0.1, 0.08]);
  });
});

describe("transcript cost-state reader", () => {
  it("reads recorded cost-state lines with their summed modelUsage", async () => {
    expect(await states("usage-transcript-after-resume")).toEqual([
      { cost: 0.00588808, tokens: { input: 1177, output: 20, cacheRead: 26918, cacheWrite: 27456 } },
      { cost: 0.006668960000000001, tokens: { input: 1179, output: 23, cacheRead: 53036, cacheWrite: 30046 } },
    ]);
  });

  it("finds the transcript under the cwd's slug, else in any project folder; a missing one is unreadable", async () => {
    const config = mkdtempSync(join(tmpdir(), "tide-claude-config-"));
    const cwd = "/work/my repo";
    mkdirSync(join(config, "projects", projectSlug(cwd)), { recursive: true });
    mkdirSync(join(config, "projects", "-elsewhere"), { recursive: true });
    const line = (cost: number) => JSON.stringify({ type: "cost-state", sessionId: "x", totalCostUSD: cost, modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } } });
    writeFileSync(join(config, "projects", projectSlug(cwd), "a.jsonl"), `{"type":"user","message":"cost-state talk"}\nnot json "cost-state"\n${line(1)}\n${line(2)}\n`);
    writeFileSync(join(config, "projects", "-elsewhere", "b.jsonl"), `${line(5)}\n`);
    expect(projectSlug(cwd)).toBe("-work-my-repo");
    expect((await readCostStates("a", { cwd, configDir: config }))?.map((s) => s.cost)).toEqual([1, 2]);
    expect(await readCostStates("b", { cwd, configDir: config })).toEqual([{ cost: 5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }]);
    expect(await readCostStates("missing", { cwd, configDir: config })).toBeUndefined();
  });
});
