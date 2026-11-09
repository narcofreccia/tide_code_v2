import { describe, expect, it } from "vitest";
import { emptyReadModel, type Project, type ReadModel } from "@tide/contracts";
import { repoGroupOf, selectRepoGroups, selectRepoSiblings } from "./repoSelectors.ts";

const repo = (remoteUrl: string): NonNullable<Project["repo"]> => ({ remoteUrl, cloneUrl: `https://${remoteUrl}.git`, defaultBranch: "main", detectedAt: 1 });
const proj = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
  id, title, rootPath: `/${id}`, createdAt: 1, updatedAt: 1, ...extra,
});
const modelOf = (...ps: Project[]): ReadModel => ({ ...emptyReadModel(), projects: Object.fromEntries(ps.map((p) => [p.id, p])) });

describe("selectRepoGroups", () => {
  it("makes one group per project when none has a repo, ordered by title", () => {
    const g = selectRepoGroups(modelOf(proj("b", "Beta"), proj("a", "Alpha")));
    expect(g.map((x) => [x.key, x.label])).toEqual([["path:a", "Alpha"], ["path:b", "Beta"]]);
  });

  it("groups clones of one remote across machines and labels it owner/name", () => {
    const url = "github.com/acme/web";
    const m = modelOf(proj("b", "web", { repo: repo(url), createdAt: 5 }), proj("a", "web", { repo: repo(url), createdAt: 2 }), proj("c", "Other"));
    const g = selectRepoGroups(m);
    const web = g.find((x) => x.key === url);
    expect(web?.label).toBe("acme/web");
    expect(web?.projects.map((p) => p.id)).toEqual(["a", "b"]);
    expect(web?.lead.id).toBe("a");
    expect(repoGroupOf(m, "b")?.key).toBe(url);
    expect(selectRepoSiblings(m, "b").map((p) => p.id)).toEqual(["a"]);
    expect(selectRepoSiblings(m, "c")).toEqual([]);
  });

  it("excludes archived projects", () => {
    const url = "github.com/acme/web";
    const m = modelOf(proj("a", "web", { repo: repo(url) }), proj("b", "web", { repo: repo(url), archivedAt: 9 }), proj("z", "Gone", { archivedAt: 9 }));
    const g = selectRepoGroups(m);
    expect(g).toHaveLength(1);
    expect(g[0]?.projects.map((p) => p.id)).toEqual(["a"]);
    expect(repoGroupOf(m, "z")).toBeUndefined();
  });

  it("leads with the pinned sibling and lists pinned groups first", () => {
    const url = "github.com/acme/web";
    const m = modelOf(
      proj("old", "web", { repo: repo(url), createdAt: 1 }),
      proj("new", "web", { repo: repo(url), createdAt: 9, pinned: true }),
      proj("a", "Aardvark"),
    );
    const g = selectRepoGroups(m);
    expect(g[0]?.lead.id).toBe("new");
    expect(g.map((x) => x.key)).toEqual([url, "path:a"]);
  });

  it("returns the same array while the projects map is unchanged", () => {
    const m = modelOf(proj("a", "A"));
    expect(selectRepoGroups(m)).toBe(selectRepoGroups({ ...m }));
  });
});
