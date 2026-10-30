import { describe, expect, it } from "vitest";
import { emptyReadModel, type PullRequest, type Thread } from "@tide/contracts";
import { prChecksSummary, prReadiness, selectOpenPrCount, sortByReadiness } from "./prSelectors.ts";

const pr = (patch: Partial<PullRequest> = {}): PullRequest => ({
  url: `https://github.com/o/r/pull/${patch.number ?? 1}`,
  number: 1,
  state: "open",
  updatedAt: 1000,
  ...patch,
});

describe("prReadiness", () => {
  it("terminal states and drafts come first", () => {
    expect(prReadiness(pr({ state: "merged", mergeable: false })).label).toBe("merged");
    expect(prReadiness(pr({ state: "closed" })).label).toBe("closed");
    expect(prReadiness(pr({ draft: true, checks: "failure" })).label).toBe("draft");
  });

  it("conflicts win over failing checks", () => {
    const r = prReadiness(pr({ mergeable: false, checks: "failure" }));
    expect(r.label).toBe("conflicts");
    expect(r.reasons[0]).toMatch(/conflicts/);
  });

  it("names failing check runs", () => {
    const r = prReadiness(
      pr({ checkRuns: [{ name: "lint", status: "failure" }, { name: "test", status: "success" }, { name: "e2e", status: "failure" }] }),
    );
    expect(r.label).toBe("checks failing");
    expect(r.reasons[0]).toBe("failing: lint, e2e");
  });

  it("falls back to the checks rollup without runs", () => {
    expect(prReadiness(pr({ checks: "failure" })).label).toBe("checks failing");
  });

  it("changes requested blocks", () => {
    const r = prReadiness(pr({ reviewDecision: "changes_requested", checks: "success" }));
    expect(r.label).toBe("changes requested");
    expect(r.score).toBe(40);
  });

  it("review required reads as needs review", () => {
    const r = prReadiness(pr({ reviewDecision: "review_required", checks: "success" }));
    expect(r.label).toBe("needs review");
    expect(r.reasons).toContain("waiting for a review");
  });

  it("approved with green checks is the most ready", () => {
    const r = prReadiness(pr({ reviewDecision: "approved", checks: "success", mergeable: true }));
    expect(r).toEqual({ score: 100, label: "ready", reasons: ["approved", "checks passed"] });
  });

  it("pending checks lower the score but stay ready", () => {
    const pending = prReadiness(pr({ reviewDecision: "approved", checkRuns: [{ name: "ci", status: "pending" }] }));
    expect(pending.label).toBe("ready");
    expect(pending.score).toBe(80);
    expect(pending.reasons).toContain("checks running");
  });

  it("no review policy sits between approved and review required", () => {
    const none = prReadiness(pr({ checks: "success" })).score;
    expect(none).toBeLessThan(prReadiness(pr({ checks: "success", reviewDecision: "approved" })).score);
    expect(none).toBeGreaterThan(prReadiness(pr({ checks: "success", reviewDecision: "review_required" })).score);
  });
});

describe("prChecksSummary", () => {
  it("ignores skipped runs", () => {
    expect(prChecksSummary(pr({ checkRuns: [{ name: "a", status: "skipped" }, { name: "b", status: "success" }] }))).toEqual({
      passed: 1,
      failed: [],
      pending: 0,
      state: "success",
    });
    expect(prChecksSummary(pr()).state).toBe("none");
  });
});

describe("sortByReadiness", () => {
  it("orders by score, then the older PR first", () => {
    const items = [
      { id: "draft", pr: pr({ number: 1, draft: true }) },
      { id: "newer", pr: pr({ number: 2, reviewDecision: "approved", checks: "success", updatedAt: 5000 }) },
      { id: "older", pr: pr({ number: 3, reviewDecision: "approved", checks: "success", updatedAt: 2000 }) },
      { id: "failing", pr: pr({ number: 4, checks: "failure" }) },
    ];
    expect(sortByReadiness(items).map((i) => i.id)).toEqual(["older", "newer", "failing", "draft"]);
    expect(items[0]?.id).toBe("draft");
  });
});

describe("selectOpenPrCount", () => {
  it("counts open thread PRs once per URL, skipping archived threads", () => {
    const model = emptyReadModel();
    const t = (id: string, patch: Partial<Thread>): Thread => ({
      id, projectId: "p1", title: id, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: 1, ...patch,
    });
    model.threads.a = t("a", { pr: pr({ number: 1 }) });
    model.threads.b = t("b", { pr: pr({ number: 1 }) });
    model.threads.c = t("c", { pr: pr({ number: 2 }), projectId: "p2" });
    model.threads.d = t("d", { pr: pr({ number: 3, state: "merged" }) });
    model.threads.e = t("e", { pr: pr({ number: 4 }), archivedAt: 5 });
    expect(selectOpenPrCount(model)).toBe(2);
    expect(selectOpenPrCount(model, "p1")).toBe(1);
  });
});
