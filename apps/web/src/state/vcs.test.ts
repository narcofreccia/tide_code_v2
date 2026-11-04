import { afterEach, describe, expect, it } from "vitest";
import { ALL_CHANGES, commitSelection, commitSha, isCommitSelection, openChangesForFile, pickFile, resetVcs, resolveSelection, useVcs } from "./vcs.ts";
import { activeTab, resetWorkbench, useWorkbench } from "./workbench.ts";
import { attachFakeStore, makeThread, makeTurn, modelWithTurns } from "../testHarness.ts";

afterEach(() => {
  resetVcs();
  resetWorkbench();
});

describe("commit selections", () => {
  it("round-trips the commit: prefix", () => {
    const sel = commitSelection("a1b2c3d");
    expect(sel).toBe("commit:a1b2c3d");
    expect(isCommitSelection(sel)).toBe(true);
    expect(commitSha(sel)).toBe("a1b2c3d");
    expect(isCommitSelection("commit:")).toBe(false);
    expect(isCommitSelection(ALL_CHANGES)).toBe(false);
    expect(commitSha("u1")).toBeUndefined();
  });

  it("resolveSelection keeps a commit pick and still falls back for stale turn ids", () => {
    const model = modelWithTurns(makeThread("t1"), [makeTurn("u1", { checkpoint: { before: "a", after: "b" } })], []);
    expect(resolveSelection(model, "t1", "commit:abc")).toBe("commit:abc");
    expect(resolveSelection(model, "t1", "gone")).toBe("u1");
  });
});

describe("openChangesForFile", () => {
  it("selects the checkpointed turn, picks the file and activates Changes", () => {
    attachFakeStore(modelWithTurns(makeThread("t1"), [makeTurn("u1", { checkpoint: { before: "a", after: "b" } })], []));
    useWorkbench.setState({ tabs: { t1: [{ kind: "changes" }, { kind: "file", path: "x.ts" }] }, active: { t1: "file:x.ts" } });
    openChangesForFile("t1", "u1", "src/a.ts");
    expect(useVcs.getState().selection.t1).toBe("u1");
    expect(useVcs.getState().pickedFile.t1).toBe("src/a.ts");
    expect(activeTab("t1").kind).toBe("changes");
  });

  it("opens the editor when the turn has no checkpoint and is not running", () => {
    attachFakeStore(modelWithTurns(makeThread("t1"), [makeTurn("u1", { status: "completed" })], []));
    openChangesForFile("t1", "u1", "src/a.ts");
    expect(useVcs.getState().selection.t1).toBeUndefined();
    expect(activeTab("t1")).toMatchObject({ kind: "file", path: "src/a.ts" });
  });

  it("follows a running turn live", () => {
    attachFakeStore(modelWithTurns(makeThread("t1"), [makeTurn("u1", { status: "running" })], []));
    openChangesForFile("t1", "u1", "src/a.ts");
    expect(useVcs.getState().selection.t1).toBe("u1");
  });

  it("pickFile stores per thread", () => {
    pickFile("t1", "a.ts");
    expect(useVcs.getState().pickedFile).toEqual({ t1: "a.ts" });
  });
});
