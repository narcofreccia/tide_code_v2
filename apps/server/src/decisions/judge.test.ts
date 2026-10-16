import { describe, expect, it } from "vitest";
import type { JudgeSite } from "@tide/contracts";
import { Judge, OVER_BUDGET, type JudgeQuestion, type LedgerSink } from "./judge.ts";
import { fakeBackend } from "./testing.ts";

const single: JudgeQuestion = { kind: "label", id: "ap1", site: "approvals", state: { tool: "Bash", command: "ls" }, instructions: "Is this routine?", labels: { routine: "harmless", consequential: "changes things" } };
const perItem: JudgeQuestion = {
  kind: "per-item",
  id: "h",
  site: "handoff",
  shared: { goal: "fix login" },
  items: [
    { key: "a", state: "turn a" },
    { key: "b", state: "turn b" },
    { key: "c", state: "turn c" },
  ],
  instructions: "Is this turn still relevant?",
};

function rig(options: { enabled?: boolean; jev?: ReturnType<typeof fakeBackend>; fallback?: ReturnType<typeof fakeBackend> } = {}) {
  const ledger: (Parameters<LedgerSink["record"]>[0])[] = [];
  const sites: JudgeSite[] = [];
  const judge = new Judge({
    jev: options.jev ?? fakeBackend("jev", () => ({ label: "routine", confidence: 0.95 })),
    ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
    ledger: { record: (e) => ledger.push(e) },
    grayZone: () => ({ low: 0.6, high: 0.85 }),
    siteEnabled: (site) => {
      sites.push(site);
      return options.enabled ?? true;
    },
    now: () => 99,
  });
  return { judge, ledger };
}

describe("Judge", () => {
  it("site disabled or no backend: one none verdict per unit, nothing asked or recorded", async () => {
    const jev = fakeBackend("jev", () => ({ confidence: 1 }));
    const off = rig({ enabled: false, jev });
    expect(await off.judge.ask(perItem)).toEqual(["h:a", "h:b", "h:c"].map((id) => ({ id, confidence: 0, source: "none", tokens: 0, elapsedMs: 0 })));
    const noBackend = rig({ jev: fakeBackend("jev", () => ({}), { available: () => false }) });
    expect((await noBackend.judge.ask(single)).map((v) => v.source)).toEqual(["none"]);
    expect(jev.calls).toHaveLength(0);
    expect(off.ledger).toHaveLength(0);
    expect(off.judge.enabled("approvals")).toBe(false);
  });

  it("Jev only: confident verdicts pass through, the fallback is never asked", async () => {
    const fallback = fakeBackend("fallback", () => ({ label: "consequential" }));
    const r = rig({ fallback });
    const [v] = await r.judge.ask(single);
    expect(v).toMatchObject({ id: "ap1", label: "routine", confidence: 0.95, source: "jev" });
    expect(fallback.calls).toHaveLength(0);
    expect(r.ledger).toEqual([expect.objectContaining({ id: "ap1", site: "approvals", at: 99, source: "jev" })]);
  });

  it("asks the fallback for the gray-zone items only, one item state per call", async () => {
    const jev = fakeBackend("jev", (u) => ({ label: "true", confidence: u.item === "b" ? 0.7 : 0.9 }));
    const fallback = fakeBackend("fallback", () => ({ label: "false", score: 0 }));
    const r = rig({ jev, fallback });
    const out = await r.judge.ask(perItem);
    expect(out.map((v) => [v.id, v.source, v.label])).toEqual([
      ["h:a", "jev", "true"],
      ["h:b", "fallback", "false"],
      ["h:c", "jev", "true"],
    ]);
    expect(jev.calls[0]).toHaveLength(1); // all three items fit one handoff call
    expect(fallback.calls[0]).toHaveLength(1);
    expect(fallback.calls[0]?.[0]?.state).toEqual({ shared: { goal: "fix login" }, items: { b: "turn b" } });
    // the jev verdict and the fallback verdict are both in the ledger
    expect(r.ledger.map((e) => `${e.id}:${e.source}`)).toEqual(["h:a:jev", "h:b:jev", "h:c:jev", "h:b:fallback"]);
  });

  it("a question threshold of 0 never reaches the fallback; a per-question threshold overrides the gray zone", async () => {
    const fallback = fakeBackend("fallback", () => ({ label: "x" }));
    const jev = fakeBackend("jev", () => ({ label: "true", confidence: 0.5 }));
    const r = rig({ jev, fallback });
    await r.judge.ask({ ...perItem, threshold: 0 });
    expect(fallback.calls).toHaveLength(0);
    await r.judge.ask({ ...single, threshold: 0.4 });
    expect(fallback.calls).toHaveLength(0);
    await r.judge.ask({ ...single, threshold: 0.6 });
    expect(fallback.calls).toHaveLength(1);
  });

  it("a fallback failure keeps Jev's verdict", async () => {
    const jev = fakeBackend("jev", () => ({ label: "routine", confidence: 0.7 }));
    const fallback = fakeBackend("fallback", () => new Error("timeout"));
    const r = rig({ jev, fallback });
    expect((await r.judge.ask(single))[0]).toMatchObject({ source: "jev", label: "routine", confidence: 0.7 });
    expect(r.ledger.map((e) => [e.source, e.error])).toEqual([["jev", undefined], ["fallback", "timeout"]]);
    // a fallback that rejects outright also keeps Jev's verdict
    const throwing = rig({ jev, fallback: { ...fakeBackend("fallback", () => ({})), ask: () => Promise.reject(new Error("boom")) } });
    expect((await throwing.judge.ask(single))[0]).toMatchObject({ source: "jev" });
  });

  it("a Jev error gives none verdicts with the error", async () => {
    const r = rig({ jev: { ...fakeBackend("jev", () => ({})), ask: () => Promise.reject(new Error("HTTP 503")) } });
    expect(await r.judge.ask(single)).toEqual([{ id: "ap1", confidence: 0, source: "none", tokens: 0, elapsedMs: 0, error: "HTTP 503" }]);
    const perCall = rig({ jev: fakeBackend("jev", () => new Error("HTTP 500")) });
    expect((await perCall.judge.ask(perItem)).map((v) => [v.source, v.error])).toEqual([["none", "HTTP 500"], ["none", "HTTP 500"], ["none", "HTTP 500"]]);
  });

  it("an over-budget single state is refused, never sent", async () => {
    const jev = fakeBackend("jev", () => ({ confidence: 1 }));
    const r = rig({ jev });
    const [v] = await r.judge.ask({ ...single, state: "x".repeat(2500 * 3 + 100) });
    expect(v).toMatchObject({ source: "none", error: OVER_BUDGET });
    expect(jev.calls).toHaveLength(0);
  });

  it("per-item with a questions map: ids carry the sub-question name, thresholds are per sub-question", async () => {
    const jev = fakeBackend("jev", (u) => ({ label: "true", score: 1, confidence: u.id.endsWith(":stuck") ? 0.6 : 0.6 }));
    const fallback = fakeBackend("fallback", () => ({ label: "false", score: 0 }));
    const r = rig({ jev, fallback });
    const out = await r.judge.ask({
      kind: "per-item",
      id: "t",
      site: "stuck",
      items: [{ key: "t0", state: { a: 1 } }],
      questions: { needsUser: { kind: "yes-no", instructions: "needs user?", threshold: 0 }, stuck: { kind: "yes-no", instructions: "stuck?" } },
    });
    expect(out.map((v) => [v.id, v.source])).toEqual([
      ["t:t0:needsUser", "jev"],
      ["t:t0:stuck", "fallback"],
    ]);
    expect(jev.calls[0]?.[0]?.units[0]?.ask.instructions).toBe('About item "t0": needs user?');
  });
});
