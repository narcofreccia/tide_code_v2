import { describe, expect, it } from "vitest";
import { SettingsStore } from "../settings.ts";
import {
  costUsd, createDecisionClient, DecisionClient, DecisionError, DecisionLimitError, DecisionsUnavailable, DEFAULT_LIMITS, estimateTokens, fetchTransport, packBatches,
  splitQuestions, TransientDecisionError, type RequestRecord, type Transport,
} from "./client.ts";
import { choice, noul, score, type Questions } from "./wire.ts";

const sleep = async (): Promise<void> => undefined;
const reply = (names: string[], usage: object | null = { input_tokens: 100, output_tokens: 5 }): unknown => ({
  model: "jev-1.13.0",
  ...(usage !== null ? { usage } : {}),
  answers: Object.fromEntries(names.map((n) => [n, { type: "noul", noul: 0.8 }])),
});

describe("DecisionClient", () => {
  it("sends {state, model, questions} and parses answers + usage", async () => {
    const calls: { payload: object; timeout: number }[] = [];
    const records: RequestRecord[] = [];
    const transport: Transport = async (payload, timeout) => {
      calls.push({ payload, timeout });
      return {
        model: "jev-1.13.0",
        usage: { input_tokens: 1_000_000, output_tokens: 3 },
        answers: { a: { type: "noul", noul: 0.9 }, b: { type: "score", score: 2.5, confidence: 0.7, probabilities: { "2": 0.5, "3": 0.5 } }, c: { type: "choice", choice: "x", confidence: 0.6, probabilities: { x: 0.6, y: 0.4 } } },
      };
    };
    const client = new DecisionClient({ transport, sleep, onRequest: (r) => records.push(r) });
    const questions: Questions = { a: noul("q?"), b: score("s?", ["lo", "mid", "hi"]), c: choice("c?", { x: null, y: "why" }) };
    const answers = await client.ask({ hello: "world" }, questions);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ state: { hello: "world" }, model: "jev-latest", questions });
    expect(answers["a"]).toMatchObject({ type: "noul", value: 0.9 });
    expect(answers["b"]).toMatchObject({ type: "score", value: 2.5, probabilities: { "2": 0.5 } });
    expect(answers["c"]).toMatchObject({ type: "choice", value: "x" });
    expect(records).toEqual([{ questions: 3, inputTokens: 1_000_000, outputTokens: 3, estimated: false, model: "jev-1.13.0", costUsd: 0.042 }]);
    expect(costUsd(1_000_000)).toBeCloseTo(0.042);
  });

  it("estimates tokens when the response carries no usage", async () => {
    const records: RequestRecord[] = [];
    const client = new DecisionClient({ transport: async () => reply(["a"], null), sleep, onRequest: (r) => records.push(r) });
    await client.ask("state", { a: noul("q") });
    expect(records[0]?.estimated).toBe(true);
    expect(records[0]?.inputTokens).toBeGreaterThan(0);
  });

  it("retries once on a transient error, then gives up", async () => {
    let n = 0;
    const flaky = new DecisionClient({ sleep, transport: async () => (++n === 1 ? Promise.reject(new TransientDecisionError("HTTP 503", 503)) : reply(["a"])) });
    await expect(flaky.ask("s", { a: noul("q") })).resolves.toHaveProperty("a");
    expect(n).toBe(2);

    let m = 0;
    const down = new DecisionClient({ sleep, transport: async () => (m++, Promise.reject(new TransientDecisionError("HTTP 500"))) });
    await expect(down.ask("s", { a: noul("q") })).rejects.toMatchObject({ code: "decision_failed" });
    expect(m).toBe(2);
  });

  it("does not retry a permanent error and wraps unexpected ones", async () => {
    let n = 0;
    const bad = new DecisionClient({ sleep, transport: async () => (n++, Promise.reject(new DecisionError("HTTP 401", 401))) });
    await expect(bad.ask("s", { a: noul("q") })).rejects.toMatchObject({ code: "decision_failed", statusCode: 401 });
    expect(n).toBe(1);
    const weird = new DecisionClient({ sleep, transport: async () => Promise.reject(new TypeError("boom")) });
    await expect(weird.ask("s", { a: noul("q") })).rejects.toBeInstanceOf(DecisionError);
  });

  it("rejects an unusable response", async () => {
    const client = new DecisionClient({ sleep, transport: async () => ({ nope: 1 }) });
    await expect(client.ask("s", { a: noul("q") })).rejects.toMatchObject({ code: "decision_failed" });
  });

  it("validates questions and limits with decision_limit", async () => {
    const client = new DecisionClient({ sleep, transport: async () => reply([]) });
    await expect(client.ask("s", { a: score("s", ["only one"]) })).rejects.toBeInstanceOf(DecisionLimitError);
    await expect(client.ask("s", { a: score("s", Array.from({ length: 11 }, (_, i) => `l${i}`)) })).rejects.toMatchObject({ code: "decision_limit" });
    await expect(client.ask("s", { a: choice("c", {}) })).rejects.toBeInstanceOf(DecisionLimitError);
    await expect(client.ask("x".repeat(100_000), { a: noul("q") })).rejects.toBeInstanceOf(DecisionLimitError);
  });

  it("splits questions across requests when they do not fit one", async () => {
    const sizes: number[] = [];
    const transport: Transport = async (payload) => {
      const qs = Object.keys((payload as { questions: object }).questions);
      sizes.push(qs.length);
      return reply(qs);
    };
    const client = new DecisionClient({ transport, sleep, limits: { ...DEFAULT_LIMITS, maxRequestTokens: 300, maxStateQuestionTokens: 300, safety: 1 } });
    const questions: Questions = {};
    for (let i = 0; i < 6; i++) questions[`q${i}`] = noul("x".repeat(150));
    const answers = await client.ask("s", questions);
    expect(Object.keys(answers)).toHaveLength(6);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("packBatches groups items under the limit and keeps an oversized one alone", () => {
    const limits = { ...DEFAULT_LIMITS, maxRequestTokens: 250, maxStateQuestionTokens: 250, safety: 1 };
    const build = (items: readonly string[]) => ({ state: items.join(""), questions: { q: noul("?") } });
    const batches = packBatches(["a".repeat(300), "b".repeat(300), "c".repeat(300), "d".repeat(2000)], build, limits);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.at(-1)).toEqual(["d".repeat(2000)]);
    expect(batches.flat()).toHaveLength(4);
    expect(splitQuestions("s", { a: noul("q") }, DEFAULT_LIMITS)).toHaveLength(1);
    expect(estimateTokens("abc")).toBe(1);
  });

  it("is unavailable when disabled, without a key, and sends nothing", async () => {
    let calls = 0;
    const transport: Transport = async () => (calls++, reply(["a"]));
    const settings = new SettingsStore();
    const client = createDecisionClient({ settings, env: {}, transport });
    await expect(client.ask("s", { a: noul("q") })).rejects.toBeInstanceOf(DecisionsUnavailable);
    settings.set({ decisions: { enabled: true } });
    await expect(client.ask("s", { a: noul("q") })).rejects.toMatchObject({ code: "decisions_unavailable" });
    settings.set({ decisions: { apiKey: "k" } });
    await expect(client.ask("s", { a: noul("q") })).resolves.toHaveProperty("a");
    settings.set({ decisions: { enabled: false } });
    expect(client.enabled).toBe(false);
    expect(calls).toBe(1);
    // env key also counts
    settings.set({ decisions: { enabled: true, apiKey: "" } });
    expect(createDecisionClient({ settings, env: { TIDE_TYPESAFE_API_KEY: "e" }, transport }).enabled).toBe(true);
  });

  it("fetchTransport posts to /v1/systemone with a bearer key and classifies statuses", async () => {
    const seen: { url: string; auth: string | undefined; body: string }[] = [];
    const make = (status: number): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)["Authorization"], body: String(init?.body) });
      return new Response(JSON.stringify({ ok: true }), { status });
    }) as typeof fetch;
    await expect(fetchTransport("k", "https://x.test/", make(200))({ a: 1 }, 1000)).resolves.toEqual({ ok: true });
    expect(seen[0]).toEqual({ url: "https://x.test/v1/systemone", auth: "Bearer k", body: '{"a":1}' });
    await expect(fetchTransport("k", "https://x.test", make(429))({}, 1000)).rejects.toBeInstanceOf(TransientDecisionError);
    await expect(fetchTransport("k", "https://x.test", make(503))({}, 1000)).rejects.toBeInstanceOf(TransientDecisionError);
    const err = await fetchTransport("k", "https://x.test", make(400))({}, 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err).not.toBeInstanceOf(TransientDecisionError);
    const net = (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await expect(fetchTransport("k", "https://x.test", net)({}, 1000)).rejects.toBeInstanceOf(TransientDecisionError);
  });
});
