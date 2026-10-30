import { afterEach, describe, expect, it } from "vitest";
import type { Message, PrComment, PrDetail, PullRequest } from "@tide/contracts";
import { emit } from "../provider/testing/fakeDriver.ts";
import { detailOf, prOf } from "./testing/fakeForge.ts";
import { activitiesOf, harness, newThread, requestTurn, type Harness } from "./testing/vcsHarness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const PR = prOf(7);
const UNIT = { name: "unit (ubuntu)", url: "https://github.com/acme/repo/actions/runs/1/job/2" };
const LATER = Date.now() + 3_600_000; // forge timestamps after every poll in the test
const open = (extra: Partial<PullRequest> = {}): PullRequest => ({ ...PR, reviewDecision: "none", comments: 0, checkRuns: [], mergeable: true, ...extra });

async function watched(h: Harness, script: (PrDetail | Error)[]): Promise<string> {
  h.forge.details.set(7, script);
  const thread = await newThread(h);
  await h.app.engine.dispatch({ type: "pr.update", threadId: thread.id, pr: PR });
  await h.app.engine.dispatch({ type: "pr.watch", threadId: thread.id, enabled: true });
  await h.app.prWatch.drain();
  return thread.id;
}

async function poll(h: Harness): Promise<void> {
  await h.app.prWatch.tick();
  await h.app.prWatch.drain();
  await h.settle();
}

const wakes = (h: Harness, threadId: string): Message[] =>
  Object.values(h.model().messages).filter((m) => m.threadId === threadId && m.role === "user" && m.notification?.source === "pr");

describe("PrWatcher", () => {
  it("refreshes the PR with the forge's facts as soon as watching starts", async () => {
    const h = await harness(cleanups);
    const threadId = await watched(h, [detailOf(open({ checks: "pending", checkRuns: [{ ...UNIT, status: "pending" }], comments: 1, title: "Fix it" }))]);
    expect(h.forge.callsOf("prDetail")).toHaveLength(1);
    expect(h.model().threads[threadId]?.pr).toMatchObject({ number: 7, checks: "pending", reviewDecision: "none", title: "Fix it", checkRuns: [{ name: "unit (ubuntu)", status: "pending" }] });
    expect(h.model().threads[threadId]?.prWatch?.lastCheckedAt).toBeDefined();
  });

  it("names the failed check and quotes the tail of its log", async () => {
    const h = await harness(cleanups);
    h.forge.logs.set("unit (ubuntu)", "expected 1\nreceived 2");
    const threadId = await watched(h, [
      detailOf(open({ checks: "pending", checkRuns: [{ ...UNIT, status: "pending" }] })),
      detailOf(open({ checks: "failure", checkRuns: [{ ...UNIT, status: "failure" }, { name: "lint", status: "success" }] })),
    ]);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await poll(h);
    const [wake] = wakes(h, threadId);
    expect(wake?.notification).toEqual({ source: "pr", summary: "PR #7: CI `unit (ubuntu)` failed" });
    expect(wake?.text).toContain("CI `unit (ubuntu)` failed. Last lines of its log:\n```\nexpected 1\nreceived 2\n```");
    expect(h.forge.callsOf("failedLog")).toEqual([[h.repo.dir, "unit (ubuntu)", 40]]);
    expect(h.model().threads[threadId]?.status).toBe("idle");
  });

  it("links the failing check when its log cannot be read", async () => {
    const h = await harness(cleanups);
    const threadId = await watched(h, [detailOf(open({ checks: "success" })), detailOf(open({ checks: "failure", checkRuns: [{ ...UNIT, status: "failure" }] }))]);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await poll(h);
    expect(wakes(h, threadId)[0]?.text).toContain(`CI \`unit (ubuntu)\` failed: ${UNIT.url}`);
  });

  it("wakes on changes requested with the review's own words", async () => {
    const h = await harness(cleanups);
    const review: PrComment = { id: "r1", author: "bob", body: "Please split the parser out.", createdAt: LATER, kind: "review", reviewState: "changes_requested" };
    const threadId = await watched(h, [detailOf(open({ reviewDecision: "review_required" })), detailOf(open({ reviewDecision: "changes_requested" }), { comments: [review] })]);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await poll(h);
    const [wake] = wakes(h, threadId);
    expect(wake?.notification?.summary).toBe("PR #7: changes requested");
    expect(wake?.text).toContain("Changes requested by @bob:\n> Please split the parser out.");
  });

  it("wakes on new line comments with path:line, never on the viewer's own", async () => {
    const h = await harness(cleanups);
    const old: PrComment = { id: "c0", author: "carol", body: "old news", createdAt: 0, kind: "comment" };
    const line: PrComment = { id: "c1", author: "alice", body: "off by one", createdAt: LATER, kind: "review-comment", path: "src/a.ts", line: 12 };
    const mine: PrComment = { id: "c2", author: "me", body: "done, pushed", createdAt: LATER, kind: "comment" };
    const threadId = await watched(h, [detailOf(open({ comments: 1 }), { comments: [old] }), detailOf(open({ comments: 3 }), { comments: [old, line, mine] })]);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await poll(h);
    const [wake] = wakes(h, threadId);
    expect(wake?.notification?.summary).toBe("PR #7: 1 new comment");
    expect(wake?.text).toContain("- @alice on `src/a.ts:12`:\n> off by one");
    expect(wake?.text).not.toContain("old news");
    expect(wake?.text).not.toContain("done, pushed");
  });

  it("sends one wake per poll even when several things changed", async () => {
    const h = await harness(cleanups);
    const threadId = await watched(h, [
      detailOf(open({ checks: "pending", reviewDecision: "none" })),
      detailOf(open({ checks: "failure", checkRuns: [{ ...UNIT, status: "failure" }], reviewDecision: "changes_requested", mergeable: false, base: "main" })),
    ]);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await poll(h);
    const all = wakes(h, threadId);
    expect(all).toHaveLength(1);
    expect(all[0]?.notification?.summary).toBe("PR #7: CI `unit (ubuntu)` failed, changes requested, conflicts with its base");
    expect(all[0]?.text).toContain("The branch now conflicts with its base (`main`).");
  });

  it("notes CI recovering without waking the agent", async () => {
    const h = await harness(cleanups);
    h.forge.details.set(7, [detailOf(open({ checks: "failure", checkRuns: [{ ...UNIT, status: "failure" }] })), detailOf(open({ checks: "success", checkRuns: [{ ...UNIT, status: "success" }] }))]);
    const thread = await newThread(h);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await requestTurn(h, thread.id, "hello");
    // already failing when watching starts (a failure first seen at that moment does wake)
    await h.app.engine.dispatch({ type: "pr.update", threadId: thread.id, pr: { ...PR, checks: "failure", checkRuns: [{ ...UNIT, status: "failure" }] } });
    await h.app.engine.dispatch({ type: "pr.watch", threadId: thread.id, enabled: true });
    await h.app.prWatch.drain();
    await poll(h);
    expect(wakes(h, thread.id)).toEqual([]);
    expect(activitiesOf(h.model(), thread.id).map((a) => ("text" in a ? a.text : undefined))).toContain("CI on pull request #7 passes again.");
  });

  it("settles the thread when it sees the PR merged, with the forge's merge time", async () => {
    const h = await harness(cleanups);
    const threadId = await watched(h, [detailOf(open()), detailOf({ ...PR, state: "merged", mergedAt: 1_234 })]);
    await poll(h);
    await h.app.engine.drain();
    const thread = h.model().threads[threadId];
    expect(thread?.prWatch).toBeUndefined();
    expect(thread).toMatchObject({ mergedAt: 1_234, settleReason: "pr-merged" });
    expect(thread?.pr?.state).toBe("merged");
  });

  it("gives up after eight consecutive forge failures", async () => {
    const h = await harness(cleanups);
    const threadId = await watched(h, [new Error("gh: not logged in")]);
    for (let i = 0; i < 6; i++) await poll(h);
    expect(h.model().threads[threadId]?.prWatch).toBeDefined();
    await poll(h);
    expect(h.forge.callsOf("prDetail")).toHaveLength(8);
    expect(h.model().threads[threadId]?.prWatch).toBeUndefined();
  });
});
