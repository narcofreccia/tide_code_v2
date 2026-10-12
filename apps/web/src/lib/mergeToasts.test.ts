import { describe, expect, it } from "vitest";
import type { MergeState } from "@tide/contracts";
import { makeThread, modelWith } from "../testHarness.ts";
import { mergeOutcomeToasts } from "./mergeToasts.ts";

const merge = (status: MergeState["status"], at: number, patch: Partial<MergeState> = {}): MergeState => ({
  status,
  strategy: "squash",
  at,
  ...patch,
});

describe("mergeOutcomeToasts", () => {
  it("announces each settled merge once, and nothing while merging", () => {
    const seen = new Map<string, MergeState | undefined>();
    seen.set("t1", undefined);
    const at = (m: MergeState | undefined) =>
      modelWith({ threads: { t1: makeThread("t1", { title: "Fix", baseBranch: "main", ...(m ? { merge: m } : {}) }) } });

    expect(mergeOutcomeToasts(seen, at(merge("merging", 1)))).toEqual([]);
    expect(mergeOutcomeToasts(seen, at(merge("conflicted", 2, { files: ["a", "b"] })))).toEqual([
      "Merge conflicted: Fix (2 files)",
    ]);
    // same report again: no repeat
    expect(mergeOutcomeToasts(seen, at(merge("conflicted", 2, { files: ["a", "b"] })))).toEqual([]);
    expect(mergeOutcomeToasts(seen, at(merge("error", 3, { error: "dirty tree" })))).toEqual([
      "Merge failed: Fix — dirty tree",
    ]);
    expect(mergeOutcomeToasts(seen, at(merge("merged", 4)))).toEqual(["Merged Fix into main"]);
  });

  it("does not re-announce a merge that settled before it was first seen", () => {
    const settled = merge("merged", 4);
    const seen = new Map<string, MergeState | undefined>([["t1", settled]]);
    const model = modelWith({ threads: { t1: makeThread("t1", { merge: settled }) } });
    expect(mergeOutcomeToasts(seen, model)).toEqual([]);
  });
});
