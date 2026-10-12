import { describe, expect, it } from "vitest";
import { emptyReadModel, type RateLimit, type ReadModel, type Thread, type Turn } from "@tide/contracts";
import {
  selectCostRollup,
  selectProjectTotals,
  selectProviderRateLimits,
  worstRateLimit,
} from "./glassBoxSelectors.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: id,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const turn = (id: string, threadId: string, costUsd: number, settledAt: number, patch: Partial<Turn> = {}): Turn => ({
  id,
  threadId,
  status: "completed",
  requestedAt: settledAt - 10,
  settledAt,
  usage: { inputTokens: 1, outputTokens: 1, costUsd },
  ...patch,
});

function build(threads: Thread[], turns: Turn[]): ReadModel {
  const model = emptyReadModel();
  for (const t of threads) model.threads[t.id] = t;
  for (const t of turns) model.turns[t.id] = t;
  return model;
}

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const THIS_MORNING = new Date(2026, 9, 12, 0, 30, 0).getTime();
const YESTERDAY_NIGHT = new Date(2026, 9, 11, 23, 30, 0).getTime();

describe("selectCostRollup", () => {
  const model = build(
    [
      // touched today, but most of its money was spent yesterday
      thread("t1", { updatedAt: NOW, totalCostUsd: 10 }),
      thread("t2", { provider: "codex", archivedAt: NOW }),
      thread("t3", { projectId: "p2" }),
    ],
    [
      turn("u1", "t1", 9, YESTERDAY_NIGHT),
      turn("u2", "t1", 1, THIS_MORNING),
      // a turn run on a different harness after a provider switch is billed to it
      turn("u3", "t1", 0.5, NOW, { provider: "opencode" }),
      turn("u4", "t2", 2, NOW),
      turn("u5", "t3", 4, NOW),
      { id: "u6", threadId: "t1", status: "running", requestedAt: NOW, usage: { inputTokens: 1, outputTokens: 1, costUsd: 3 } },
    ],
  );

  it("counts only turns settled today (local day) towards today", () => {
    const cost = selectCostRollup(model, ["p1"], NOW);
    expect(cost.todayUsd).toBeCloseTo(3.5);
    expect(cost.lifetimeUsd).toBeCloseTo(15.5);
  });

  it("rolls up by the provider that ran each turn, most expensive first", () => {
    const cost = selectCostRollup(model, ["p1"], NOW);
    expect(cost.byProvider.map((p) => p.provider)).toEqual(["claude", "codex", "opencode"]);
    expect(cost.byProvider[0]).toMatchObject({ todayUsd: 1, lifetimeUsd: 13 });
  });

  it("covers every project when unscoped", () => {
    expect(selectCostRollup(model, undefined, NOW).lifetimeUsd).toBeCloseTo(19.5);
  });

  it("feeds selectProjectTotals", () => {
    const totals = selectProjectTotals(model, "p1", NOW);
    expect(totals.threads).toBe(1);
    expect(totals.costTodayUsd).toBeCloseTo(3.5);
    expect(totals.costLifetimeUsd).toBeCloseTo(15.5);
    expect(totals.costByProvider).toHaveLength(3);
  });
});

describe("rate limits", () => {
  const rl = (status: RateLimit["status"], at: number, note?: string): RateLimit => ({
    status,
    at,
    ...(note === undefined ? {} : { note }),
  });

  it("worstRateLimit prefers severity, then recency", () => {
    expect(worstRateLimit(rl("warning", 1), rl("limited", 0))?.status).toBe("limited");
    expect(worstRateLimit(rl("ok", 1, "a"), rl("ok", 2, "b"))?.note).toBe("b");
    expect(worstRateLimit(undefined, rl("ok", 1))?.status).toBe("ok");
  });

  it("selectProviderRateLimits takes the worst live thread per provider", () => {
    const model = build(
      [
        thread("t1", { rateLimit: rl("warning", 1) }),
        thread("t2", { rateLimit: rl("limited", 2) }),
        thread("t3", { provider: "codex", rateLimit: rl("ok", 1) }),
        thread("t4", { provider: "codex", rateLimit: rl("limited", 5), archivedAt: 9 }),
      ],
      [],
    );
    const limits = selectProviderRateLimits(model);
    expect(limits.claude?.status).toBe("limited");
    expect(limits.codex?.status).toBe("ok");
    expect(limits.pi).toBeUndefined();
  });
});
