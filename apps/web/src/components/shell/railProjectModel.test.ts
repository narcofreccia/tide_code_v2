import { describe, expect, it } from "vitest";
import type { Project } from "@tide/contracts";
import { emptyReadModel } from "@tide/contracts";
import { selectRepoGroups } from "@tide/client";
import { makeThread } from "../../testHarness.ts";
import type { RailGroup } from "./railGroupModel.ts";
import { buildRailProjectModel } from "./railProjectModel.ts";

const proj = (id: string, title: string, pinned?: boolean): Project => ({
  id, title, rootPath: `/${id}`, createdAt: 1, updatedAt: 1, ...(pinned === undefined ? {} : { pinned }),
});
const repoGroups = (ps: Project[]) => selectRepoGroups({ ...emptyReadModel(), projects: Object.fromEntries(ps.map((p) => [p.id, p])) });
const group = (key: RailGroup["key"], threads: RailGroup["threads"]): RailGroup => ({ key, threads, sessions: [] });

describe("buildRailProjectModel", () => {
  const projects = [proj("a", "Atlas"), proj("t", "Tide"), proj("z", "Zed", true), proj("e", "Empty")];
  const groups: RailGroup[] = [
    group("needs", [makeThread("n1", { projectId: "t" })]),
    group("inbox", [makeThread("i1", { projectId: "t" }), makeThread("i2", { projectId: "a", pinned: true }), makeThread("i3", { projectId: "a" })]),
    group("working", [makeThread("w1", { projectId: "t", status: "running" })]),
    group("snoozed", [makeThread("s1", { projectId: "a" })]),
    group("settled", []),
    group("archived", []),
  ];

  it("orders folders pinned first then by title and drops empty unpinned ones", () => {
    const m = buildRailProjectModel(groups, repoGroups(projects), []);
    expect(m.folders.map((f) => f.project.id)).toEqual(["z", "a", "t"]);
  });

  it("keeps threads in needs, inbox, working order and lifts pinned threads", () => {
    const m = buildRailProjectModel(groups, repoGroups(projects), []);
    expect(m.folders.find((f) => f.project.id === "t")?.threads.map((t) => t.id)).toEqual(["n1", "i1", "w1"]);
    expect(m.pinnedThreads.map((t) => t.id)).toEqual(["i2"]);
    expect(m.folders.find((f) => f.project.id === "a")?.threads.map((t) => t.id)).toEqual(["i3"]);
  });

  it("counts needs and running per folder", () => {
    const t = buildRailProjectModel(groups, repoGroups(projects), []).folders.find((f) => f.project.id === "t");
    expect(t?.needsCount).toBe(1);
    expect(t?.running).toBe(true);
  });

  it("keeps an empty folder when its project is filtered to, and passes the tail groups through", () => {
    const m = buildRailProjectModel(groups, repoGroups(projects), ["e"]);
    expect(m.folders.map((f) => f.project.id)).toContain("e");
    expect(m.snoozed.map((x) => x.id)).toEqual(["s1"]);
  });

  it("folds clones of one repo on different machines into a single folder", () => {
    const repo = { remoteUrl: "github.com/acme/web", cloneUrl: "https://github.com/acme/web.git", defaultBranch: "main", detectedAt: 1 };
    const ps = [{ ...proj("m1", "web"), repo }, { ...proj("m2", "web"), repo, createdAt: 2 }];
    const gs: RailGroup[] = [
      group("needs", [makeThread("n", { projectId: "m2" })]),
      group("inbox", [makeThread("i", { projectId: "m1" })]),
      group("working", [makeThread("w", { projectId: "m2", status: "running" })]),
    ];
    const m = buildRailProjectModel(gs, repoGroups(ps), []);
    expect(m.folders).toHaveLength(1);
    const f = m.folders[0];
    expect(f?.key).toBe("github.com/acme/web");
    expect(f?.label).toBe("acme/web");
    expect(f?.project.id).toBe("m1");
    expect(f?.projects.map((p) => p.id)).toEqual(["m1", "m2"]);
    expect(f?.threads.map((t) => t.id)).toEqual(["n", "i", "w"]);
    expect(f?.needsCount).toBe(1);
    expect(f?.running).toBe(true);
  });
});
