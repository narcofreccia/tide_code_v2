import { describe, expect, it } from "vitest";
import { applyRecord, emptyReadModel, type ReadModel } from "@tide/contracts";
import { MergedModel } from "./mergedModel.ts";
import { selectAllThreads, selectProjects } from "./selectors.ts";

function withProject(model: ReadModel, seq: number, id: string): ReadModel {
  return applyRecord(model, {
    seq,
    ts: seq,
    event: { type: "project.created", project: { id, title: id, rootPath: `/${id}`, createdAt: seq, updatedAt: seq } },
  });
}

function withThread(model: ReadModel, seq: number, id: string, projectId: string): ReadModel {
  return {
    ...model,
    seq,
    threads: {
      ...model.threads,
      [id]: { id, projectId, title: id, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: seq, updatedAt: seq },
    },
  };
}

describe("MergedModel", () => {
  it("unions every map and records which environment owns what", () => {
    const merged = new MergedModel();
    merged.set("a", withThread(withProject(emptyReadModel(), 1, "pa"), 2, "ta", "pa"));
    merged.set("b", withThread(withProject(emptyReadModel(), 1, "pb"), 2, "tb", "pb"));
    expect(merged.commit()).toBe(true);

    expect(Object.keys(merged.model.projects).sort()).toEqual(["pa", "pb"]);
    expect(Object.keys(merged.model.threads).sort()).toEqual(["ta", "tb"]);
    expect(merged.model.seq).toBe(4);
    expect(merged.ownership.threads).toEqual({ ta: "a", tb: "b" });
    expect(merged.ownerOf("projects", "pb")).toBe("b");
    expect(merged.ownerOf("threads", "nope")).toBeUndefined();
    // selectors work on the union unchanged
    expect(selectProjects(merged.model).map((p) => p.id).sort()).toEqual(["pa", "pb"]);
    expect(selectAllThreads(merged.model, "pb").map((t) => t.id)).toEqual(["tb"]);
  });

  it("keeps identities that did not change (structural sharing)", () => {
    const merged = new MergedModel();
    const a = withProject(emptyReadModel(), 1, "pa");
    const b = withProject(emptyReadModel(), 1, "pb");
    merged.set("a", a);
    merged.set("b", b);
    merged.commit();
    const first = merged.model;
    merged.set("a", a);
    expect(merged.commit()).toBe(false);
    expect(merged.model).toBe(first);

    merged.set("a", withThread(a, 2, "ta", "pa"));
    expect(merged.commit()).toBe(true);
    expect(merged.model.projects).toBe(first.projects);
    expect(merged.model.threads).not.toBe(first.threads);
  });

  it("passes a single environment's maps through untouched", () => {
    const merged = new MergedModel();
    const a = withProject(emptyReadModel(), 1, "pa");
    merged.set("a", a);
    merged.commit();
    expect(merged.model.projects).toBe(a.projects);
  });

  it("drops an environment's data and ownership on removal", () => {
    const merged = new MergedModel();
    merged.seedOwnership({ projects: { pb: "b" }, threads: { tb: "b", tx: "a", tc: "c" } });
    merged.set("a", withProject(emptyReadModel(), 1, "pa"));
    merged.set("b", withThread(withProject(emptyReadModel(), 1, "pb"), 2, "tb", "pb"));
    merged.commit();
    merged.remove("b");
    expect(merged.commit()).toBe(true);
    expect(Object.keys(merged.model.projects)).toEqual(["pa"]);
    expect(merged.model.threads).toEqual({});
    expect(merged.ownerOf("threads", "tb")).toBeUndefined();
    // "a" has its model (seq > 0), so its stale seed is gone; "c" has not answered yet
    expect(merged.ownership.threads).toEqual({ tc: "c" });
  });

  it("answers from the persisted seed before any snapshot arrives", () => {
    const merged = new MergedModel();
    merged.seedOwnership({ projects: { p1: "remote" }, threads: { t1: "remote" } });
    expect(merged.ownerOf("threads", "t1")).toBe("remote");
    expect(merged.ownership.projects).toEqual({ p1: "remote" });
  });

  it("renames a provisional environment id", () => {
    const merged = new MergedModel();
    merged.seedOwnership({ projects: {}, threads: { t0: "local" } });
    merged.set("local", emptyReadModel());
    merged.commit();
    merged.rename("local", "env-9");
    expect(merged.ownership.threads.t0).toBe("env-9");
    merged.set("env-9", withProject(emptyReadModel(), 1, "pa"));
    merged.commit();
    expect(merged.ownerOf("projects", "pa")).toBe("env-9");
    expect(merged.envIds()).toEqual(["env-9"]);
  });
});
