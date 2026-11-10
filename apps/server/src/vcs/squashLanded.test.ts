import { afterEach, describe, expect, it } from "vitest";
import { findLandedSquash } from "./squashLanded.ts";
import { createTempRepo, type TempRepo } from "./testing/tempRepo.ts";

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

/** main at `base`, branch `tide/x` with two commits of work. */
async function setup(): Promise<{ repo: TempRepo; base: string; tip: string }> {
  const repo = await createTempRepo("tide-squash-");
  repos.push(repo);
  const base = (await repo.git.revParse("HEAD")) as string;
  await repo.git.run(["checkout", "-q", "-b", "tide/x"]);
  await repo.write("a.txt", "a\n");
  await repo.commit("a");
  await repo.write("b.txt", "b\n");
  const tip = await repo.commit("b");
  await repo.git.run(["checkout", "-q", "main"]);
  return { repo, base, tip };
}

const squash = async (repo: TempRepo): Promise<string> => {
  await repo.git.run(["merge", "--squash", "tide/x"]);
  return repo.commit("squashed");
};

describe("findLandedSquash", () => {
  it("finds the squash commit right after the recorded base", async () => {
    const { repo, base, tip } = await setup();
    const sq = await squash(repo);
    expect(await findLandedSquash(repo.git, base, sq, tip)).toBe(sq);
  });

  it("finds it under later commits, and when the base had moved before the merge started", async () => {
    const { repo, tip } = await setup();
    await repo.write("m.txt", "m\n");
    const recorded = await repo.commit("main moved first");
    const sq = await squash(repo);
    await repo.write("later.txt", "l\n");
    const later = await repo.commit("later");
    expect(await findLandedSquash(repo.git, recorded, later, tip)).toBe(sq);
  });

  it("rejects an unmoved base, an unrelated commit, a partial squash and a base that is not a descendant", async () => {
    const { repo, base, tip } = await setup();
    expect(await findLandedSquash(repo.git, base, base, tip)).toBeUndefined();
    await repo.write("other.txt", "o\n");
    const other = await repo.commit("other");
    expect(await findLandedSquash(repo.git, base, other, tip)).toBeUndefined();
    await repo.git.run(["reset", "-q", "--hard", base]);
    await repo.write("a.txt", "a\n");
    const partial = await repo.commit("only a");
    expect(await findLandedSquash(repo.git, base, partial, tip)).toBeUndefined();
    expect(await findLandedSquash(repo.git, other, partial, tip)).toBeUndefined();
  });
});
