import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../provider/testing/fakeDriver.ts";
import { prChanges } from "./prWatch.ts";
import { harness, newThread, type Harness } from "./testing/vcsHarness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const PR = { url: "https://github.com/acme/repo/pull/7", number: 7, state: "open" as const, updatedAt: 1 };

async function watched(h: Harness): Promise<string> {
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

describe("prChanges", () => {
  it("wakes on a CI failure, more comments or a new conflict, never on a first comment count", () => {
    expect(prChanges({ ...PR }, { ...PR, checks: "pending", comments: 3, mergeable: true })).toEqual([]);
    expect(prChanges({ ...PR, checks: "pending", comments: 3 }, { ...PR, checks: "failure", comments: 5, mergeable: false })).toEqual([
      "CI checks failed",
      "2 new comments or reviews",
      "the branch now conflicts with its base",
    ]);
    expect(prChanges({ ...PR, checks: "failure", mergeable: false }, { ...PR, checks: "failure", mergeable: false })).toEqual([]);
  });
});

describe("PrWatcher", () => {
  it("refreshes the PR as soon as watching starts", async () => {
    const h = await harness(cleanups);
    h.gh.statuses = [{ state: "open", checks: "pending", mergeable: true, comments: 1 }];
    const threadId = await watched(h);
    expect(h.gh.statusCalls).toEqual([7]);
    expect(h.model().threads[threadId]?.pr).toMatchObject({ number: 7, checks: "pending", mergeable: true, comments: 1 });
    expect(h.model().threads[threadId]?.prWatch?.lastCheckedAt).toBeDefined();
  });

  it("wakes the thread when CI fails", async () => {
    const h = await harness(cleanups);
    h.gh.statuses = [{ state: "open", checks: "pending", comments: 0 }, { state: "open", checks: "failure", comments: 0 }];
    const threadId = await watched(h);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await poll(h);
    const model = h.model();
    const prompt = Object.values(model.messages).find((m) => m.threadId === threadId && m.role === "user");
    expect(prompt?.notification).toEqual({ source: "pr", summary: "PR #7: CI checks failed" });
    expect(prompt?.text).toMatch(/^Pull request #7 changed: CI checks failed\./);
    expect(model.threads[threadId]?.status).toBe("idle");
  });

  it("stops watching once the PR is merged", async () => {
    const h = await harness(cleanups);
    h.gh.statuses = [{ state: "open", comments: 0 }, { state: "merged", comments: 0 }];
    const threadId = await watched(h);
    await poll(h);
    expect(h.model().threads[threadId]?.prWatch).toBeUndefined();
    expect(h.model().threads[threadId]?.pr?.state).toBe("merged");
  });

  it("gives up after eight consecutive gh failures", async () => {
    const h = await harness(cleanups);
    h.gh.statuses = [new Error("gh: not logged in")];
    const threadId = await watched(h);
    for (let i = 0; i < 6; i++) await poll(h);
    expect(h.model().threads[threadId]?.prWatch).toBeDefined();
    await poll(h);
    expect(h.gh.statusCalls).toHaveLength(8);
    expect(h.model().threads[threadId]?.prWatch).toBeUndefined();
  });
});
