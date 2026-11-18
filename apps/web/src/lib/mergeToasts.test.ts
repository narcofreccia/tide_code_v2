import { describe, expect, it } from "vitest";
import type { MergeState, Project } from "@tide/contracts";
import { makeThread, modelWith } from "../testHarness.ts";
import { mergeOutcomeToasts, mergeToastItems, type PullContext } from "./mergeToasts.ts";

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

  it("stays quiet about merges already settled in the first snapshot (the hook mounts on an empty model)", () => {
    const seen = new Map<string, MergeState | undefined>();
    const loaded = modelWith({
      threads: {
        old: makeThread("old", { title: "Old", baseBranch: "main", merge: merge("merged", 4) }),
        failed: makeThread("failed", { title: "Failed", merge: merge("error", 5, { error: "x" }) }),
        live: makeThread("live", { title: "Live", baseBranch: "main", merge: merge("merging", 6) }),
      },
    });
    expect(mergeOutcomeToasts(seen, loaded)).toEqual([]);
    // the one that was still merging at load is announced when it lands
    const landed = modelWith({ threads: { ...loaded.threads, live: makeThread("live", { title: "Live", baseBranch: "main", merge: merge("merged", 7) }) } });
    expect(mergeOutcomeToasts(seen, landed)).toEqual(["Merged Live into main"]);
  });

  it("offers to pull the base on the primary when the merge ran on another machine", () => {
    const repo = { remoteUrl: "github.com/acme/app", cloneUrl: "git@github.com:acme/app.git", defaultBranch: "main", detectedAt: 1 };
    const project = (id: string): Project => ({ id, title: id, rootPath: `/${id}`, repo, createdAt: 1, updatedAt: 1 }) as Project;
    const owners: Record<string, string> = { "p-remote": "env-b", "p-here": "env-a", t1: "env-b" };
    const ctx = (primaryId: string, pushes = true): PullContext => ({
      primaryId,
      envOfThread: (id) => owners[id],
      envOfProject: (id) => owners[id],
      pushesBase: () => pushes,
    });
    const model = modelWith({
      projects: { "p-remote": project("p-remote"), "p-here": project("p-here") },
      threads: { t1: makeThread("t1", { title: "Fix", projectId: "p-remote", baseBranch: "main", merge: merge("merged", 2) }) },
    });
    expect(mergeToastItems(new Map([["t1", undefined]]), model, ctx("env-a"))).toEqual([
      { text: "Merged Fix into main", pull: { projectId: "p-here", base: "main" } },
    ]);
    // merged on the primary itself: nothing to pull
    expect(mergeToastItems(new Map([["t1", undefined]]), model, ctx("env-b"))).toEqual([{ text: "Merged Fix into main" }]);
    // the owner does not push its base (the default): origin has nothing new, so no pull is offered
    expect(mergeToastItems(new Map([["t1", undefined]]), model, ctx("env-a", false))).toEqual([{ text: "Merged Fix into main" }]);
  });
});
