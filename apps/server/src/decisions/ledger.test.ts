import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { EventStore } from "../orchestration/store.ts";
import { JudgeLedger, startOfDay } from "./ledger.ts";

const stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

async function ledger(): Promise<{ ledger: JudgeLedger; store: EventStore }> {
  const store = new EventStore(await openDatabase(":memory:"));
  stores.push(store);
  return { ledger: new JudgeLedger(store), store };
}

describe("JudgeLedger", () => {
  it("sums today's spend per source and site, counting Jev calls once per request", async () => {
    const { ledger: l } = await ledger();
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    const yesterday = startOfDay(now) - 1;
    const base = { confidence: 0.9, elapsedMs: 40 };
    // one Jev request answering two triage units
    l.record({ ...base, id: "t:a", site: "stuck", source: "jev", tokens: 301, costUsd: 0.00001, callId: "c1", model: "jev-1.13.0", at: now });
    l.record({ ...base, id: "t:b", site: "stuck", source: "jev", tokens: 300, costUsd: 0.00001, callId: "c1", model: "jev-1.13.0", at: now });
    // a second request on another site
    l.record({ ...base, id: "ap", site: "approvals", source: "jev", label: "routine", tokens: 100, costUsd: 0.000004, callId: "c2", at: now });
    // a fallback verdict and a fallback failure
    l.record({ ...base, id: "t:b", site: "stuck", source: "fallback", label: "true", score: 1, tokens: 0, model: "haiku", at: now + 1 });
    l.record({ ...base, id: "x", site: "stuck", source: "fallback", confidence: 0, tokens: 0, error: "timeout", at: now + 2 });
    // an over-budget refusal (no call) and yesterday's request
    l.record({ ...base, id: "big", site: "handoff", source: "none", confidence: 0, tokens: 0, error: "over budget", at: now });
    l.record({ ...base, id: "old", site: "stuck", source: "jev", tokens: 999, costUsd: 1, callId: "c0", at: yesterday });

    const stats = l.statsToday(now);
    expect(stats.today.jev).toEqual({ calls: 2, tokens: 701, usd: expect.closeTo(0.000024, 9) });
    expect(stats.today.fallback).toEqual({ calls: 2, tokens: 0, usd: 0 });
    expect(stats.bySite["stuck"]).toMatchObject({ calls: 3, tokens: 601 });
    expect(stats.bySite["approvals"]).toMatchObject({ calls: 1, tokens: 100 });
    expect(stats.bySite["handoff"]).toBeUndefined();

    const recent = l.recent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]).toEqual({ at: now + 2, site: "stuck", source: "fallback", questionId: "x", confidence: 0, tokens: 0, elapsedMs: 40, error: "timeout" });
    expect(recent[1]).toMatchObject({ questionId: "t:b", source: "fallback", label: "true", score: 1, model: "haiku" });
    expect(l.stats(now, 50).recent).toHaveLength(7);
  });

  it("shares the event store's connection and survives being built twice", async () => {
    const { store, ledger: l } = await ledger();
    l.record({ id: "q", site: "experts", source: "jev", confidence: 1, tokens: 5, elapsedMs: 1, callId: "c", at: 1 });
    expect(new JudgeLedger(store).recent(10)).toHaveLength(1);
    expect(store.readAll()).toEqual([]); // never in the event log
  });
});
