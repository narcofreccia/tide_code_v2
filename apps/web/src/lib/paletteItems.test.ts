import { afterEach, describe, expect, it } from "vitest";
import type { ReadModel } from "@tide/contracts";
import { buildPaletteItems, rankPaletteItems, type PaletteItem } from "./paletteItems.ts";
import { attachFakeStore, makePlan, makeThread, modelWith, resetUi, makeExpertsSession } from "../testHarness.ts";
import { useUi } from "../state/ui.ts";

afterEach(() => {
  resetUi();
  delete (window as unknown as Record<string, unknown>)["__TAURI__"];
});

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
  it("offers New thread… once, with the ⌘N hint, when a project is in scope", () => {
    (window as unknown as Record<string, unknown>)["__TAURI__"] = {};
    const model = fixture();
    const withProject = buildPaletteItems({ model, selectedThreadId: "t1" });
    const item = withProject.find((i) => i.id === "project:new-thread");
    expect(item?.label).toBe("New thread…");
    expect(item?.kbd).toBe("⌘N");
    expect(item?.detail).toBe("Tide");
    // the keyboard-map entry is not offered a second time
    expect(withProject.filter((i) => i.id === "shortcut:new-thread")).toHaveLength(0);

    item?.run();
    expect(useUi.getState().newThreadProjectId).toBe("p1");

    const noProject = buildPaletteItems({ model: modelWith({}), selectedThreadId: null });
    expect(noProject.some((i) => i.id === "project:new-thread")).toBe(false);
  });

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
        "thread:delete",
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

describe("linked repositories item", () => {
  it("appears only with a project in scope and opens its links editor", () => {
    const model = fixture();
    expect(buildPaletteItems({ model, selectedThreadId: null }).map((i) => i.id)).not.toContain("project:links");

    const fromRail = buildPaletteItems({ model, selectedThreadId: null, selectedProjectId: "p1" });
    const item = fromRail.find((i) => i.id === "project:links");
    expect(item?.label).toBe("Manage linked repositories…");

    // a selected thread scopes it to that thread's project
    expect(buildPaletteItems({ model, selectedThreadId: "t1" }).map((i) => i.id)).toContain("project:links");

    item?.run();
    expect(useUi.getState().linksProjectId).toBe("p1");
  });
});

describe("settle items", () => {
  it("offers Settle / Unsettle for the open thread and Undo settle after one", async () => {
    const { resetSettleUndo, settleThreads } = await import("./inboxActions.ts");
    const model = fixture();
    const fake = attachFakeStore(model);
    const ids = (threadId: string | null) => buildPaletteItems({ model, selectedThreadId: threadId }).map((i) => i.id);
    expect(ids("t1")).toContain("thread:settle");
    expect(ids(null)).not.toContain("action:undo-settle");
    model.threads.t2 = { ...model.threads.t2!, settledAt: 3, settleReason: "user" };
    expect(ids("t2")).toContain("thread:unsettle");
    await settleThreads(["t1"]);
    const undo = buildPaletteItems({ model, selectedThreadId: null }).find((i) => i.id === "action:undo-settle");
    expect(undo?.kbd).toBe("⌘Z");
    undo?.run();
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.unsettle", threadId: "t1" });
    expect(ids(null)).not.toContain("action:undo-settle");
    resetSettleUndo();
  });
});

describe("rankPaletteItems recency", () => {
  const t = (id: string): PaletteItem => ({ id: `thread:${id}`, label: `Fix ${id}`, group: "Go to", run: () => {} });
  const action: PaletteItem = { id: "a", label: "Action", group: "Actions", run: () => {} };

  it("orders thread targets newest-opened first with no query", () => {
    const out = rankPaletteItems("", [t("x"), action, t("y"), t("z")], [], { y: 30, z: 10 });
    expect(out.map((i) => i.id)).toEqual(["thread:y", "a", "thread:z", "thread:x"]);
  });

  it("nudges a recently opened thread over an equal match", () => {
    const out = rankPaletteItems("fix", [t("x"), t("y")], [], { y: 10 });
    expect(out[0]!.id).toBe("thread:y");
  });
});
