import { afterEach, describe, expect, it } from "vitest";
import type { ReadModel } from "@tide/contracts";
import { buildPaletteItems, rankPaletteItems } from "./paletteItems.ts";
import { attachFakeStore, makePlan, makeThread, modelWith, resetUi, makeExpertsSession } from "../testHarness.ts";
import { useUi } from "../state/ui.ts";

afterEach(() => resetUi());

function fixture(): ReadModel {
  const model = modelWith({
    projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
    threads: {
      t1: makeThread("t1", { title: "Refactor router", worktreePath: "/wt/t1", branch: "tide/t1" }),
      t2: makeThread("t2", { title: "Docs pass", status: "running" }),
    },
    expertsSessions: { x1: makeExpertsSession("x1") },
  });
  model.plans["pl1"] = makePlan("pl1", { threadId: "t1" });
  return model;
}

describe("palette items", () => {
  it("covers all three sources", () => {
    const items = buildPaletteItems({ model: fixture(), selectedThreadId: null });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("shortcut:mission");
    expect(ids).toContain("project:p1");
    expect(ids).toContain("thread:t1");
    expect(ids).toContain("experts:x1");
    // shortcut items carry their keyboard hint
    expect(items.find((i) => i.id === "shortcut:mission")?.kbd).toBe("⌘0");
  });

  it("adds contextual thread actions only when a thread is selected", () => {
    const model = fixture();
    const without = buildPaletteItems({ model, selectedThreadId: null }).map((i) => i.id);
    expect(without).not.toContain("thread:archive");
    expect(without).not.toContain("thread:detach");

    const with1 = buildPaletteItems({ model, selectedThreadId: "t1" }).map((i) => i.id);
    expect(with1).toEqual(
      expect.arrayContaining([
        "thread:terminal",
        "thread:archive",
        "thread:child",
        "thread:implement-plan",
        "thread:detach",
      ]),
    );
    // t1 is idle and t2 has no worktree/plan
    expect(with1).not.toContain("thread:stop");
    const with2 = buildPaletteItems({ model, selectedThreadId: "t2" }).map((i) => i.id);
    expect(with2).toContain("thread:stop");
    expect(with2).not.toContain("thread:detach");
    expect(with2).not.toContain("thread:implement-plan");
  });

  it("hides Stop while the interrupt is still settling", () => {
    const model = fixture();
    model.threads["t2"] = makeThread("t2", { status: "running", interrupting: true });
    const ids = buildPaletteItems({ model, selectedThreadId: "t2" }).map((i) => i.id);
    expect(ids).not.toContain("thread:stop");
  });

  it("ranks fuzzily and puts recents first when the query is empty", () => {
    attachFakeStore(fixture());
    const items = buildPaletteItems({ model: fixture(), selectedThreadId: "t1" });
    const ranked = rankPaletteItems("refrou", items);
    expect(ranked[0]?.id).toBe("thread:t1");

    const empty = rankPaletteItems("", items, ["project:p1", "shortcut:rail"]);
    expect(empty.slice(0, 2).map((i) => i.id)).toEqual(["project:p1", "shortcut:rail"]);
    expect(empty).toHaveLength(items.length);
  });

  it("hides out-of-context actions and never offers to open itself", () => {
    const model = fixture();
    const onMission = buildPaletteItems({ model, selectedThreadId: null }).map((i) => i.id);
    expect(onMission).not.toContain("shortcut:palette");
    expect(onMission).not.toContain("shortcut:quick-open");
    expect(onMission).not.toContain("shortcut:terminal");
    expect(onMission).not.toContain("shortcut:focus-split");
    // always-scoped entries survive
    expect(onMission).toEqual(expect.arrayContaining(["shortcut:mission", "shortcut:rail", "shortcut:theme"]));

    useUi.getState().selectThread("t1");
    const onThread = buildPaletteItems({ model, selectedThreadId: "t1" }).map((i) => i.id);
    expect(onThread).toEqual(
      expect.arrayContaining(["shortcut:focus-split", "shortcut:quick-open", "shortcut:terminal"]),
    );

    // the workbench is hidden in thread-only focus, so its entries drop out again
    useUi.getState().setFocusMode("thread");
    const threadOnly = buildPaletteItems({ model, selectedThreadId: "t1" }).map((i) => i.id);
    expect(threadOnly).toContain("shortcut:focus-split");
    expect(threadOnly).not.toContain("shortcut:quick-open");
  });

  it("labels a jump target with project, provider and status", () => {
    const items = buildPaletteItems({ model: fixture(), selectedThreadId: null });
    const row = items.find((i) => i.id === "thread:t2");
    expect(row?.label).toContain("Docs pass");
    expect(row?.detail).toBe("Tide · claude · running");
  });
});
