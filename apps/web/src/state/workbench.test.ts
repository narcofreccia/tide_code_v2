import { afterEach, describe, expect, it } from "vitest";
import {
  activeTab,
  closeActiveTab,
  closeTab,
  moveTab,
  openFileTab,
  openSearchTab,
  setActiveTab,
  tabKey,
  threadTabs,
  togglePin,
  useWorkbench,
  WORKBENCH_STORAGE_KEY,
} from "./workbench.ts";
import { resetUi } from "../testHarness.ts";

afterEach(() => resetUi());

describe("workbench tabs", () => {
  it("starts with Changes only", () => {
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }]);
    expect(activeTab("t1")).toEqual({ kind: "changes" });
  });

  it("opens a file tab, focuses it, and does not duplicate it", () => {
    openFileTab("t1", "src/a.ts");
    openFileTab("t1", "src/a.ts");
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }, { kind: "file", path: "src/a.ts" }]);
    expect(tabKey(activeTab("t1"))).toBe("file:src/a.ts");
  });

  it("records a reveal target when opening at a line", () => {
    openFileTab("t1", "src/a.ts", { line: 42, column: 3 });
    expect(useWorkbench.getState().reveal["t1:src/a.ts"]).toMatchObject({ line: 42, column: 3, nonce: 1 });
    openFileTab("t1", "src/a.ts", { line: 42, column: 3 });
    expect(useWorkbench.getState().reveal["t1:src/a.ts"]?.nonce).toBe(2);
  });

  it("closes a tab and falls back to a neighbour", () => {
    openFileTab("t1", "src/a.ts");
    openFileTab("t1", "src/b.ts");
    closeTab("t1", { kind: "file", path: "src/b.ts" });
    expect(tabKey(activeTab("t1"))).toBe("file:src/a.ts");
    closeTab("t1", { kind: "file", path: "src/a.ts" });
    expect(activeTab("t1")).toEqual({ kind: "changes" });
  });

  it("never closes Changes", () => {
    setActiveTab("t1", { kind: "changes" });
    closeActiveTab("t1");
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }]);
  });

  it("⌘W leaves a pinned tab alone", () => {
    openFileTab("t1", "src/a.ts");
    togglePin("t1", "src/a.ts");
    closeActiveTab("t1");
    expect(threadTabs("t1")).toHaveLength(2);
  });

  it("pinning moves the tab to the front of the file section", () => {
    openFileTab("t1", "src/a.ts");
    openFileTab("t1", "src/b.ts");
    togglePin("t1", "src/b.ts");
    expect(threadTabs("t1")).toEqual([
      { kind: "changes" },
      { kind: "file", path: "src/b.ts", pinned: true },
      { kind: "file", path: "src/a.ts" },
    ]);
  });

  it("reorders file tabs but keeps Changes first", () => {
    openFileTab("t1", "src/a.ts");
    openFileTab("t1", "src/b.ts");
    moveTab("t1", 2, 0);
    expect(threadTabs("t1")[0]).toEqual({ kind: "changes" });
    expect(threadTabs("t1")[1]).toEqual({ kind: "file", path: "src/b.ts" });
  });

  it("inserts Search right after Changes", () => {
    openFileTab("t1", "src/a.ts");
    openSearchTab("t1");
    expect(threadTabs("t1").map((t) => t.kind)).toEqual(["changes", "search", "file"]);
    expect(tabKey(activeTab("t1"))).toBe("search");
  });

  it("keeps tabs per thread and persists paths only", () => {
    openFileTab("t1", "src/a.ts");
    openFileTab("t2", "src/b.ts");
    expect(threadTabs("t2")).toEqual([{ kind: "changes" }, { kind: "file", path: "src/b.ts" }]);
    const stored = JSON.parse(window.localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? "{}");
    expect(stored.state.tabs.t1).toEqual([{ kind: "changes" }, { kind: "file", path: "src/a.ts" }]);
    expect(stored.state).not.toHaveProperty("reveal");
  });
});
