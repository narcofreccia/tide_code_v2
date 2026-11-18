import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DomainEvent, EventRecord } from "@tide/contracts";
import { RESTART_ERROR } from "../orchestration/recovery.ts";
import { claudeConfigDirs, costStateReader } from "./ingest/costStates.ts";
import { planRepair, repairTotals, scanRepairEvents } from "./repair.ts";

interface FixtureEvent {
  seq: number;
  ts: number;
  type: "turn.started" | "usage.reported" | "turn.settled";
  turnId: string;
  nativeSessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  status?: "completed" | "interrupted" | "error";
}
const FIXTURE = JSON.parse(readFileSync(new URL("../../test/fixtures/usage/inflated-series.fixture.json", import.meta.url), "utf8")) as {
  events: FixtureEvent[];
  costStates: { totalCostUSD: number }[];
};

function fixtureRecords(): EventRecord[] {
  return FIXTURE.events.map((e) => {
    const threadId = "thread-1";
    let event: DomainEvent;
    if (e.type === "turn.started") event = { type: "turn.started", turnId: e.turnId, threadId, provider: "claude", ...(e.nativeSessionId ? { nativeSessionId: e.nativeSessionId } : {}), startedAt: e.ts };
    else if (e.type === "usage.reported")
      event = { type: "usage.reported", turnId: e.turnId, threadId, ...(e.costUsd !== undefined ? { usage: { inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0, costUsd: e.costUsd } } : {}), at: e.ts };
    else event = { type: "turn.settled", turnId: e.turnId, threadId, status: e.status ?? "completed", settledAt: e.ts };
    return { seq: e.seq, ts: e.ts, event };
  });
}

const storedTotal = (): number => FIXTURE.events.reduce((a, e) => a + (e.costUsd ?? 0), 0);
const fixtureTotals = new Map([["session-1", FIXTURE.costStates.map((c) => c.totalCostUSD)]]);

/** Tiny event-log builder: turns of one thread, each with one cost report. */
function log() {
  const records: EventRecord[] = [];
  let seq = 0;
  const push = (event: DomainEvent): void => {
    records.push({ seq: ++seq, ts: seq, event });
  };
  const api = {
    records,
    turn(id: string, cost: number | undefined, startedAt: number, opts: { session?: string | null; thread?: string; provider?: "claude" | "codex"; settledAt?: number; status?: "completed" | "error" | "interrupted"; error?: string } = {}) {
      const threadId = opts.thread ?? "t";
      push({ type: "turn.started", turnId: id, threadId, provider: opts.provider ?? "claude", ...(opts.session !== null ? { nativeSessionId: opts.session ?? "s" } : {}), startedAt });
      if (cost !== undefined) push({ type: "usage.reported", turnId: id, threadId, usage: { inputTokens: 1, outputTokens: 1, costUsd: cost }, at: startedAt + 1000 });
      push({ type: "turn.settled", turnId: id, threadId, status: opts.status ?? "completed", ...(opts.error !== undefined ? { error: opts.error } : {}), settledAt: opts.settledAt ?? startedAt + 2000 });
      return api;
    },
    push(event: DomainEvent) {
      push(event);
      return api;
    },
  };
  return api;
}

const MIN = 60_000;

describe("planRepair on the recorded thread", () => {
  it("finds every inflated report with the transcript and leaves the honest deltas alone", () => {
    expect(storedTotal()).toBeCloseTo(2539.4956, 3);
    const rows = planRepair({ scan: scanRepairEvents(fixtureRecords()), costStates: fixtureTotals, titleOf: () => "Thread" });
    expect(rows.map((r) => r.turnId)).toEqual(
      [35, 41, 49, 50, 56, 58, 62, 69, 74, 85, 87, 88, 90, 91, 92, 104, 105, 106].map((n) => `turn-${n}`),
    );
    expect(rows.every((r) => r.evidence === "transcript" && !r.applied && r.threadTitle === "Thread")).toBe(true);
    const byTurn = new Map(rows.map((r) => [r.turnId, r]));
    // the last one is Claude's own final total less the one before it
    expect(byTurn.get("turn-106")?.correctedUsd).toBeCloseTo(214.44630974 - 208.82372074, 6);
    expect(byTurn.get("turn-87")?.correctedUsd).toBeCloseTo(162.04822121 - 157.62304941, 6);

    const totals = repairTotals(rows);
    const repaired = storedTotal() - totals.storedUsd + totals.correctedUsd;
    // From turn 35 on the series is Claude's own chain and ends on its final cost-state (214.45).
    // Turns 1–11 ran in a process whose total (31.02, saved as the first cost-state 31.06) the
    // next process did not restore (turn 12 starts from zero and turns 12–34 sum to the second
    // cost-state exactly), so they are real spend that Claude's final total leaves out.
    const firstProcess = FIXTURE.events.filter((e) => Number(e.turnId.slice(5)) <= 11).reduce((a, e) => a + (e.costUsd ?? 0), 0);
    expect(firstProcess).toBeCloseTo(31.02, 2);
    expect(repaired).toBeCloseTo(214.4463 + firstProcess, 2);
    expect(repaired).toBeCloseTo(245.465, 2);
  });

  it("without a transcript the gap rule finds nothing here: Claude's chain restarted below Tide's sum", () => {
    expect(planRepair({ scan: scanRepairEvents(fixtureRecords()), costStates: new Map() })).toEqual([]);
  });

  it("marks rows already corrected and plans the same figures again", () => {
    const records = fixtureRecords();
    records.push({ seq: 1e9, ts: 1e9, event: { type: "usage.corrected", turnId: "turn-106", threadId: "thread-1", usage: { inputTokens: 0, outputTokens: 0, costUsd: -208.82372074 }, reason: "x", at: 1e9 } });
    const rows = planRepair({ scan: scanRepairEvents(records), costStates: fixtureTotals });
    expect(rows).toHaveLength(18);
    expect(rows.filter((r) => r.applied).map((r) => r.turnId)).toEqual(["turn-106"]);
  });
});

describe("planRepair rules", () => {
  it("never touches an honest series, nor an expensive first turn of a session", () => {
    const records = log()
      .turn("1", 40, 0)
      .turn("2", 1, 5 * MIN)
      .turn("3", 2, 10 * MIN)
      .turn("4", 50, 0, { session: "other" }).records;
    expect(planRepair({ scan: scanRepairEvents(records), costStates: new Map() })).toEqual([]);
    expect(planRepair({ scan: scanRepairEvents(records), costStates: new Map([["s", [43]], ["other", [50]]]) })).toEqual([]);
  });

  it("an honest reopened turn that costs less than the session so far stays", () => {
    const records = log().turn("1", 3, 0).turn("2", 2, 2 * 60 * MIN).records;
    expect(planRepair({ scan: scanRepairEvents(records), costStates: new Map() })).toEqual([]);
  });

  it("heuristic: after a gap over 30 minutes a report at least the session's total is cumulative", () => {
    const records = log().turn("1", 3, 0).turn("2", 1, MIN).turn("3", 4.5, 40 * MIN).turn("4", 0.5, 41 * MIN).turn("5", 6, 120 * MIN).records;
    const rows = planRepair({ scan: scanRepairEvents(records), costStates: new Map() });
    expect(rows.map((r) => [r.turnId, r.storedUsd, r.correctedUsd, r.evidence])).toEqual([
      ["3", 4.5, 0.5, "heuristic"],
      ["5", 6, 1, "heuristic"],
    ]);
  });

  it("a short gap is not a reopen without other evidence", () => {
    const records = log().turn("1", 3, 0).turn("2", 5, 20 * MIN).records;
    expect(planRepair({ scan: scanRepairEvents(records), costStates: new Map() })).toEqual([]);
  });

  it("transcript: a run that sums to a saved total proves a process ended, gap or not", () => {
    const records = log().turn("1", 3, 0).turn("2", 1, MIN).turn("3", 4.25, 2 * MIN).records;
    const rows = planRepair({ scan: scanRepairEvents(records), costStates: new Map([["s", [4, 4.25]]]) });
    expect(rows.map((r) => [r.turnId, r.correctedUsd, r.evidence])).toEqual([["3", 0.25, "transcript"]]);
  });

  it("a transcript that confirms nothing keeps the heuristic out", () => {
    const records = log().turn("1", 3, 0).turn("2", 5, 120 * MIN).records;
    expect(planRepair({ scan: scanRepairEvents(records), costStates: new Map([["s", [2.9, 8]]]) })).toEqual([]);
  });

  it("an error, a server stop, a rollback or another harness in between also reopen the session", () => {
    const cases = [
      log().turn("1", 3, 0, { status: "error" }).turn("2", 4, MIN),
      log().turn("1", 3, 0, { status: "interrupted", error: RESTART_ERROR }).turn("2", 4, MIN),
      log().turn("1", 3, 0).turn("x", 1, MIN, { thread: "other", session: "x-s", status: "interrupted", error: RESTART_ERROR }).turn("2", 4, 2 * MIN),
      log().turn("1", 3, 0).push({ type: "rollback.completed", threadId: "t", turnId: "1", turnIds: [], provider: "claude", at: MIN }).turn("2", 4, 2 * MIN),
      log().turn("1", 3, 0).turn("c", 9, MIN, { provider: "codex", session: "codex-s" }).turn("2", 4, 2 * MIN),
    ];
    for (const c of cases) {
      const rows = planRepair({ scan: scanRepairEvents(c.records), costStates: new Map() });
      expect(rows.map((r) => [r.turnId, r.correctedUsd])).toEqual([["2", 1]]);
    }
  });

  it("groups by the session a turn identified later, and ignores other harnesses", () => {
    const b = log().turn("1", 3, 0).turn("2", 4, 60 * MIN, { session: null });
    b.push({ type: "turn.session-identified", turnId: "2", threadId: "t", provider: "claude", nativeSessionId: "s", at: 60 * MIN });
    b.turn("c1", 3, 0, { provider: "codex", session: "x", thread: "c" }).turn("c2", 9, 90 * MIN, { provider: "codex", session: "x", thread: "c" });
    const rows = planRepair({ scan: scanRepairEvents(b.records), costStates: new Map() });
    expect(rows.map((r) => r.turnId)).toEqual(["2"]);
  });

  it("totals add up the rows", () => {
    const records = log().turn("1", 3, 0).turn("2", 5, 120 * MIN).records;
    const result = repairTotals(planRepair({ scan: scanRepairEvents(records), costStates: new Map() }), 1);
    expect(result).toMatchObject({ storedUsd: 5, correctedUsd: 2, appliedCount: 1 });
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(["applied", "at", "correctedUsd", "evidence", "storedUsd", "threadId", "threadTitle", "turnId"]);
  });
});

describe("costStateReader", () => {
  it("finds the transcript under any project folder of any config dir and reads only cost-state totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tide-cost-state-"));
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(join(b, "projects", "-Users-me-repo"), { recursive: true });
    writeFileSync(
      join(b, "projects", "-Users-me-repo", "abc-123.jsonl"),
      ['{"type":"user","message":"cost-state"}', '{"type":"cost-state","totalCostUSD":1.5}', "not json", '{"type":"cost-state","totalCostUSD":2.25,"models":{}}'].join("\n"),
    );
    const read = costStateReader([a, b]);
    expect(await read("abc-123")).toEqual([1.5, 2.25]);
    expect(await read("missing")).toBeUndefined();
    expect(await read("../escape")).toBeUndefined();
  });

  it("lists CLAUDE_CONFIG_DIR, ~/.claude and the instance homes once each", () => {
    expect(claudeConfigDirs("/h", { CLAUDE_CONFIG_DIR: "/cfg" }, ["/acct", "/cfg"])).toEqual(["/cfg", "/h/.claude", "/acct"]);
    expect(claudeConfigDirs("/h", {})).toEqual(["/h/.claude"]);
  });
});
