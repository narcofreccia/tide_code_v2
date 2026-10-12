import { describe, expect, it } from "vitest";
import { emptyReadModel, type Activity, type ReadModel, type Thread } from "@tide/contracts";
import { DEFAULT_LIMITS } from "./client.ts";
import { buildTriageRequests, lastActivityAt, mapAnswers, threadState, triageCandidates } from "./triage.ts";
import type { Answer } from "./wire.ts";

const NOW = 10_000_000;
const MIN = 60_000;

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return { id, projectId: "p1", title: `title ${id}`, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: 1, ...patch };
}

function model(): ReadModel {
  const m = emptyReadModel();
  m.projects["p1"] = { id: "p1", title: "P", rootPath: "/r", createdAt: 1, updatedAt: 1 };
  m.threads["run"] = thread("run", { status: "running", createdAt: 2, latestTurnId: "u1" });
  m.threads["att"] = thread("att", { attention: "approval", createdAt: 3 });
  m.threads["recent"] = thread("recent", { createdAt: 4, latestTurnId: "u2" });
  m.threads["old"] = thread("old", { createdAt: 5, latestTurnId: "u3" });
  m.threads["arch"] = thread("arch", { status: "running", archivedAt: 9, createdAt: 6 });
  m.threads["other"] = thread("other", { projectId: "p2", status: "running", createdAt: 7 });
  m.turns["u1"] = { id: "u1", threadId: "run", status: "running", requestedAt: NOW - 20 * MIN, startedAt: NOW - 20 * MIN };
  m.turns["u2"] = { id: "u2", threadId: "recent", status: "completed", requestedAt: NOW - 40 * MIN, settledAt: NOW - 10 * MIN };
  m.turns["u3"] = { id: "u3", threadId: "old", status: "completed", requestedAt: NOW - 90 * MIN, settledAt: NOW - 60 * MIN };
  // the running thread's stream
  m.messages["m1"] = { id: "m1", threadId: "run", turnId: "u1", role: "user", text: "u".repeat(900), createdAt: NOW - 20 * MIN };
  m.messages["m2"] = { id: "m2", threadId: "run", turnId: "u1", role: "assistant", text: "a".repeat(1500), createdAt: NOW - 15 * MIN };
  m.threadMessages["run"] = ["m1", "m2"];
  const timeline: { kind: "activity"; id: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const a: Activity = { id: `a${i}`, threadId: "run", turnId: "u1", createdAt: NOW - 14 * MIN, updatedAt: NOW - (14 - i) * MIN, kind: "tool", toolUseId: `tu${i}`, toolName: `Tool${i}`, input: {}, status: i === 9 ? "running" : "ok" };
    m.activities[a.id] = a;
    timeline.push({ kind: "activity", id: a.id });
  }
  m.activities["ap"] = { id: "ap", threadId: "run", turnId: "u1", createdAt: NOW - 3 * MIN, updatedAt: NOW - 3 * MIN, kind: "approval", requestId: "r", toolName: "Bash", input: {}, title: "Run rm -rf build", status: "pending" };
  timeline.push({ kind: "activity", id: "ap" });
  m.threadTimeline["run"] = timeline;
  m.plans["pl"] = { id: "pl", threadId: "run", turnId: "u1", markdown: "plan", status: "proposed", createdAt: 1, updatedAt: 1 };
  return m;
}

describe("triage candidates and state", () => {
  it("picks running, attention and recently settled threads of the project, not archived or old ones", () => {
    expect(triageCandidates(model(), "p1", NOW).map((t) => t.id)).toEqual(["run", "att", "recent"]);
  });

  it("builds a compact state for a thread", () => {
    const m = model();
    const s = threadState(m, m.threads["run"] as Thread, NOW) as Record<string, unknown>;
    expect(s).toMatchObject({ title: "title run", provider: "claude", status: "running", attention: "none", planProposed: true, minutesSinceLastActivity: 3 });
    expect((s["lastUserMessage"] as string).length).toBeLessThanOrEqual(800);
    expect((s["lastAssistantText"] as string).length).toBeLessThanOrEqual(1200);
    const lines = s["recentActivities"] as string[];
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toBe("PENDING APPROVAL: Run rm -rf build (Bash)");
    expect(lines.at(-2)).toBe("Tool9 running");
    expect(lines[0]).toBe("Tool3 ok");
    expect(lastActivityAt(m, m.threads["run"] as Thread)).toBe(NOW - 3 * MIN);
  });

  it("builds one batched request with three questions per thread", () => {
    const requests = buildTriageRequests(model(), "p1", NOW, DEFAULT_LIMITS);
    expect(requests).toHaveLength(1);
    const r = requests[0];
    expect(r?.threadIds).toEqual(["run", "att", "recent"]);
    expect(Object.keys(r?.questions ?? {})).toEqual(["t0__needsUser", "t0__stuck", "t0__urgency", "t1__needsUser", "t1__stuck", "t1__urgency", "t2__needsUser", "t2__stuck", "t2__urgency"]);
    expect(r?.questions["t0__urgency"]).toMatchObject({ type: "score" });
    expect((r?.questions["t0__urgency"] as { criteria: string[] }).criteria).toHaveLength(5);
    expect(r?.questions["t1__needsUser"]).toMatchObject({ type: "noul" });
    expect(Object.keys(r?.state as object)).toEqual(["t0", "t1", "t2"]);
  });

  it("splits into several requests when the limits are tight, and none for an empty project", () => {
    const tight = { ...DEFAULT_LIMITS, maxRequestTokens: 1500, maxStateQuestionTokens: 1500, safety: 1 };
    expect(buildTriageRequests(model(), "p1", NOW, tight).length).toBeGreaterThan(1);
    expect(buildTriageRequests(model(), "none", NOW, DEFAULT_LIMITS)).toEqual([]);
  });

  it("maps answers: score -> expected level / 4, clamped; incomplete threads skipped", () => {
    const req = { threadIds: ["x", "y"], state: {}, questions: {} };
    const noulA = (p: number): Answer => ({ type: "noul", value: p, confidence: p, probabilities: {} });
    const scoreA = (v: number): Answer => ({ type: "score", value: v, confidence: 1, probabilities: {} });
    const out = mapAnswers(req, { t0__needsUser: noulA(0.9), t0__stuck: noulA(0.1), t0__urgency: scoreA(3), t1__needsUser: noulA(0.5) }, 42);
    expect(out.get("x")).toEqual({ needsUser: 0.9, stuck: 0.1, urgency: 0.75, at: 42 });
    expect(out.has("y")).toBe(false);
    expect(mapAnswers(req, { t0__needsUser: noulA(1), t0__stuck: noulA(0), t0__urgency: scoreA(9) }, 1).get("x")?.urgency).toBe(1);
  });
});
