import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DecisionLimitError } from "./client.ts";
import { DEFAULT_CAPS, fit, pack, packState } from "./budget.ts";
import { unitsOf, type JudgeQuestion, type PerItemQuestion } from "./judge.ts";

function question(sizes: number[], shared?: string): PerItemQuestion {
  return {
    kind: "per-item",
    id: "q",
    site: "stuck",
    ...(shared !== undefined ? { shared } : {}),
    items: sizes.map((n, i) => ({ key: `k${i}`, state: "x".repeat(n) })),
    questions: { a: { kind: "yes-no", instructions: "a?" }, b: { kind: "score", instructions: "b?", levels: ["lo", "hi"] } },
  };
}

describe("budget", () => {
  it("packs items under the state and item caps; every item lands in exactly one call or is refused", () => {
    const caps = { stateTokens: 1000, itemsPerCall: 3 };
    const sizes = [600, 600, 600, 600, 5000, 30, 30, 30, 30, 1500, 2990];
    const q = question(sizes, "shared");
    const units = unitsOf(q);
    const { calls, refused } = pack(q, units, caps, DEFAULT_LIMITS);
    const sentKeys = calls.flatMap((c) => Object.keys((c.state as { items: Record<string, unknown> }).items));
    const refusedKeys = [...new Set(refused.map((u) => u.item))];
    // no item's state is ever sent twice, none is lost
    expect(new Set(sentKeys).size).toBe(sentKeys.length);
    expect([...sentKeys, ...refusedKeys].sort()).toEqual(q.items.map((i) => i.key).sort());
    expect(refusedKeys.sort()).toEqual(["k10", "k4"]);
    for (const call of calls) {
      expect(JSON.stringify(call.state).length / 3).toBeLessThanOrEqual(caps.stateTokens);
      expect(Object.keys((call.state as { items: object }).items).length).toBeLessThanOrEqual(caps.itemsPerCall);
      // each call carries exactly its items' units
      const keys = Object.keys((call.state as { items: object }).items);
      expect(call.units.map((u) => u.item)).toEqual(keys.flatMap((k) => [k, k]));
      expect((call.state as { shared: string }).shared).toBe("shared");
    }
    expect(calls.map((c) => c.units.length / 2)).toEqual([3, 3, 3]);
  });

  it("groups up to itemsPerCall small items and keeps the state flat without a shared part", () => {
    const q = question(Array(30).fill(10));
    const { calls, refused } = pack(q, unitsOf(q), DEFAULT_CAPS.stuck, DEFAULT_LIMITS);
    expect(refused).toEqual([]);
    expect(calls.map((c) => Object.keys(c.state as object).length)).toEqual([12, 12, 6]);
    const big = question([1200, 1200, 1200]);
    expect(pack(big, unitsOf(big), { stateTokens: 1000, itemsPerCall: 40 }, DEFAULT_LIMITS).calls.map((c) => Object.keys(c.state as object))).toEqual([["k0", "k1"], ["k2"]]);
    expect(packState(undefined, [{ key: "a", state: "s" }])).toEqual({ a: "s" });
  });

  it("fit refuses an over-cap single state", () => {
    const q: JudgeQuestion = { kind: "yes-no", id: "d", site: "delegates", state: "y".repeat(3000 * 3 + 30), instructions: "done?" };
    expect(() => fit(q, unitsOf(q), DEFAULT_CAPS.delegates, DEFAULT_LIMITS)).toThrow(DecisionLimitError);
    const ok: JudgeQuestion = { ...q, state: "short" };
    expect(fit(ok, unitsOf(ok), DEFAULT_CAPS.delegates, DEFAULT_LIMITS)).toMatchObject({ site: "delegates", state: "short", stateTokens: 3000 });
  });
});
