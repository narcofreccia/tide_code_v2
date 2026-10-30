import { describe, expect, it } from "vitest";
import type { PrComment, PullRequest } from "@tide/contracts";
import { detailOf, prOf } from "./testing/fakeForge.ts";
import { checksRecovered, newComments, newlyFailed, prWake } from "./prWake.ts";

const prev = (extra: Partial<PullRequest> = {}): PullRequest => prOf(7, { updatedAt: 1_000, comments: 0, reviewDecision: "none", ...extra });
const comment = (i: number, extra: Partial<PrComment> = {}): PrComment => ({ id: `c${i}`, author: `u${i}`, body: `note ${i}`, createdAt: 2_000 + i, kind: "comment", ...extra });

describe("prWake", () => {
  it("is quiet when nothing actionable changed", () => {
    expect(prWake(prev({ checks: "pending" }), detailOf(prOf(7, { checks: "success", mergeable: true })))).toBeUndefined();
  });

  it("only reports checks that newly failed, once per name", () => {
    const fail = (name: string) => ({ name, status: "failure" as const });
    expect(newlyFailed(prev({ checkRuns: [fail("a")] }), prOf(7, { checkRuns: [fail("a"), fail("b"), fail("b")] })).map((c) => c.name)).toEqual(["b"]);
    expect(newlyFailed(prev({ checks: "failure" }), prOf(7, { checkRuns: [fail("a")] }))).toEqual([]);
    expect(checksRecovered(prev({ checks: "failure" }), prOf(7, { checks: "success" }))).toBe(true);
  });

  it("ignores history on the first poll and the viewer's own comments", () => {
    const d = detailOf(prOf(7), { comments: [comment(1), comment(2, { author: "me" })] });
    expect(newComments(prOf(7, { updatedAt: 1_000 }), d)).toEqual([]);
    expect(newComments(prev(), d).map((c) => c.id)).toEqual(["c1"]);
  });

  it("caps comments at five, bodies at 600 chars and the review at 1,500", () => {
    const comments = [...Array.from({ length: 7 }, (_, i) => comment(i, { body: i === 0 ? "x".repeat(900) : `note ${i}` })), { ...comment(9), kind: "review" as const, reviewState: "changes_requested", body: "y".repeat(2_000) }];
    const wake = prWake(prev({ reviewDecision: "review_required" }), detailOf(prOf(7, { reviewDecision: "changes_requested" }), { comments }));
    expect(wake?.summary).toBe("PR #7: changes requested, 7 new comments");
    expect(wake?.text).toContain(`> ${"y".repeat(1_499)}…`);
    expect(wake?.text).toContain(`> ${"x".repeat(599)}…`);
    expect(wake?.text).toContain("- …and 2 more (`gh pr view 7 --comments`).");
    expect(wake?.text).not.toContain("note 5");
  });
});
