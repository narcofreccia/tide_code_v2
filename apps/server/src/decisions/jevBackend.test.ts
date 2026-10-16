import { describe, expect, it } from "vitest";
import { DecisionClient, DecisionLimitError, DEFAULT_LIMITS, type RequestRecord, type Transport } from "./client.ts";
import { answerToVerdict, JevBackend } from "./jevBackend.ts";
import { unitsOf, type JudgeCall, type JudgeQuestion } from "./judge.ts";
import { noul } from "./wire.ts";

const sleep = async (): Promise<void> => undefined;

describe("DecisionClient.askMany", () => {
  it("sends each pre-packed call as one request, tags the site, and isolates a failing call", async () => {
    const payloads: object[] = [];
    const records: RequestRecord[] = [];
    let n = 0;
    const transport: Transport = async (payload) => {
      payloads.push(payload);
      if (++n === 2) throw new Error("bad gateway");
      return { model: "jev-1.13.0", usage: { input_tokens: 90, output_tokens: 2 }, answers: { q0: { type: "noul", noul: 0.8 } } };
    };
    const client = new DecisionClient({ transport, sleep, onRequest: (r) => records.push(r) });
    const out = await client.askMany([{ state: "a", questions: { q0: noul("?") } }, { state: "b", questions: { q0: noul("?") } }, { state: "c", questions: { q0: noul("?") } }], "stuck");
    expect(payloads).toHaveLength(3);
    expect(out[0]?.answers?.["q0"]).toMatchObject({ value: 0.8 });
    expect(out[1]?.error?.message).toContain("bad gateway");
    expect(out[2]?.record).toMatchObject({ site: "stuck", inputTokens: 90 });
    expect(records.map((r) => r.site)).toEqual(["stuck", "stuck"]);
  });

  it("never re-splits: a call over the limits throws before anything is sent", async () => {
    const payloads: object[] = [];
    const client = new DecisionClient({ transport: async (p) => (payloads.push(p), {}), sleep, limits: { ...DEFAULT_LIMITS, maxStateQuestionTokens: 100, maxRequestTokens: 100 } });
    await expect(client.askMany([{ state: "x".repeat(400), questions: { q0: noul("?") } }])).rejects.toBeInstanceOf(DecisionLimitError);
    expect(payloads).toHaveLength(0);
  });
});

describe("JevBackend", () => {
  const q: JudgeQuestion = {
    kind: "per-item",
    id: "t",
    site: "stuck",
    items: [{ key: "t0", state: {} }],
    questions: { yes: { kind: "yes-no", instructions: "y?" }, lvl: { kind: "score", instructions: "s?", levels: ["a", "b", "c"] }, pick: { kind: "label", instructions: "l?", labels: { x: "x", y: "y" } } },
  };
  const call: JudgeCall = { site: "stuck", state: { t0: {} }, stateTokens: 8000, units: unitsOf(q) };

  it("maps answers to verdicts using Answer.confidence and splits the call's cost across its verdicts", async () => {
    const transport: Transport = async () => ({
      model: "jev-1.13.0",
      usage: { input_tokens: 100, output_tokens: 3 },
      answers: { q0: { type: "noul", noul: 0.3 }, q1: { type: "score", score: 1.5, confidence: 0.66, probabilities: {} }, q2: { type: "choice", choice: "y", confidence: 0.81, probabilities: {} } },
    });
    const backend = new JevBackend(new DecisionClient({ transport, sleep }), () => "call-1");
    const out = await backend.ask([call]);
    expect(out[0]).toMatchObject({ id: "t:t0:yes", label: "false", score: 0.3, confidence: 0.7, source: "jev", tokens: 34, callId: "call-1", model: "jev-1.13.0" });
    expect(out[1]).toMatchObject({ id: "t:t0:lvl", label: "2", score: 0.75, confidence: 0.66, tokens: 33 });
    expect(out[2]).toMatchObject({ id: "t:t0:pick", label: "y", confidence: 0.81 });
    expect(out.reduce((a, v) => a + v.tokens, 0)).toBe(100);
    expect(out.reduce((a, v) => a + (v.costUsd ?? 0), 0)).toBeCloseTo(100 * 0.042e-6, 12);
  });

  it("a failed call or a disabled client gives none verdicts with the error", async () => {
    const failing = new JevBackend(new DecisionClient({ transport: async () => Promise.reject(new Error("nope")), sleep }));
    expect((await failing.ask([call])).map((v) => [v.source, v.error])).toEqual([["none", "Error: nope"], ["none", "Error: nope"], ["none", "Error: nope"]]);
    const off = new JevBackend(new DecisionClient({ transport: async () => ({}), sleep, enabled: () => false }));
    expect(off.available()).toBe(false);
    expect((await off.ask([call]))[0]).toMatchObject({ source: "none", error: "decisions are not enabled" });
    expect(answerToVerdict("x", { kind: "yes-no", instructions: "" }, { type: "noul", value: 0.9, confidence: 0.9, probabilities: {} })).toMatchObject({ label: "true", score: 0.9 });
  });
});
