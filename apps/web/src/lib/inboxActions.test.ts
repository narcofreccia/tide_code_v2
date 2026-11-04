import { afterEach, describe, expect, it, vi } from "vitest";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../testHarness.ts";
import { useToasts } from "../state/toast.ts";
import { mergeableOf, mergeBackThreads, mergeSkipSummary } from "./inboxActions.ts";

afterEach(() => resetUi());

const wt = { branch: "tide/x", worktreePath: "/wt/x" };
const threads = {
  a: makeThread("a", { ...wt }),
  run: makeThread("run", { ...wt, status: "running" }),
  merged: makeThread("merged", { ...wt, mergedAt: 5 }),
  bare: makeThread("bare", { branch: "tide/bare" }),
  b: makeThread("b", { ...wt }),
};

describe("mergeableOf", () => {
  it("keeps idle, unmerged threads with a branch and a worktree, in id order given", () => {
    const model = modelWith({ threads });
    expect(mergeableOf(model, ["b", "run", "merged", "bare", "a", "gone"]).map((t) => t.id)).toEqual(["b", "a"]);
    expect(mergeSkipSummary(model, ["run", "merged", "bare", "a"])).toBe("1 running · 1 merged · 1 without a worktree");
  });
});

describe("mergeBackThreads", () => {
  it("dispatches thread.merge sequentially", async () => {
    const fake = attachFakeStore(modelWith({ threads }));
    const order: string[] = [];
    let release: () => void = () => undefined;
    fake.dispatch.mockImplementation(async (c: { threadId: string }) => {
      order.push(`start ${c.threadId}`);
      if (c.threadId === "a") await new Promise<void>((r) => (release = r));
      order.push(`end ${c.threadId}`);
      return { seq: 0, events: [] };
    });
    const done = mergeBackThreads(["a", "b"]);
    await vi.waitFor(() => expect(order).toEqual(["start a"]));
    release();
    await done;
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("toasts a refused dispatch and carries on", async () => {
    const fake = attachFakeStore(modelWith({ threads: { a: makeThread("a", { title: "Alpha" }), b: makeThread("b") } }));
    fake.dispatch.mockRejectedValueOnce(new Error("dirty tree"));
    await mergeBackThreads(["a", "b"]);
    expect(fake.dispatch).toHaveBeenCalledTimes(2);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Merge refused: Alpha — dirty tree"]);
  });
});
