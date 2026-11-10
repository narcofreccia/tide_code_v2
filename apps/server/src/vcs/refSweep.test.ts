import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadModel } from "@tide/contracts";
import { Git } from "./git.ts";
import { sweepOrphanCheckpointRefs } from "./refSweep.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "./testing/tempRepo.ts";

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

/** Only the fields the sweep reads. */
function model(projects: Record<string, string>, threads: string[]): ReadModel {
  return {
    projects: Object.fromEntries(Object.entries(projects).map(([id, rootPath]) => [id, { id, rootPath }])),
    threads: Object.fromEntries(threads.map((id) => [id, { id }])),
  } as unknown as ReadModel;
}

describe("sweepOrphanCheckpointRefs", () => {
  it("deletes refs of threads missing from the model in batches, once per repository", async () => {
    const repo = await createTempRepo("tide-sweep-");
    repos.push(repo);
    const head = (await repo.git.revParse("HEAD")) as string;
    for (const t of ["keep", "gone1", "gone2"]) for (const turn of ["a", "b"]) await repo.git.updateRef(`refs/tide/checkpoints/${t}/${turn}/before`, head);
    await repo.git.updateRef("refs/tide/archived/gone1", head);
    const calls: string[][] = [];
    const git = (cwd: string): Git => {
      const g = new Git(cwd, { env: GIT_TEST_ENV });
      const run = g.tryRun.bind(g);
      g.tryRun = (args, env) => (calls.push(args), run(args, env));
      return g;
    };
    // two projects on one repository: listed once
    const result = await sweepOrphanCheckpointRefs({ git, log: () => undefined }, model({ p1: repo.dir, p2: repo.dir }, ["keep"]), { batch: 3 });
    expect(result.deleted.get(repo.dir)).toBe(4);
    expect(calls.filter((c) => c[0] === "for-each-ref")).toHaveLength(1);
    expect((await repo.git.listRefs("refs/tide/checkpoints/")).map((r) => r.ref).sort()).toEqual(["refs/tide/checkpoints/keep/a/before", "refs/tide/checkpoints/keep/b/before"]);
    // only checkpoints are swept
    expect(await repo.git.revParse("refs/tide/archived/gone1")).toBe(head);
  });

  it("keeps ids its log never knew, skips missing folders and non-repositories, never throws", async () => {
    const repo = await createTempRepo("tide-sweep-");
    repos.push(repo);
    const head = (await repo.git.revParse("HEAD")) as string;
    await repo.git.updateRef("refs/tide/checkpoints/known/t/after", head);
    await repo.git.updateRef("refs/tide/checkpoints/stranger/t/after", head);
    const plain = await mkdtemp(join(tmpdir(), "tide-sweep-plain-"));
    const logs: string[] = [];
    try {
      const result = await sweepOrphanCheckpointRefs(
        { git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }), log: (m) => logs.push(m) },
        model({ a: repo.dir, b: join(plain, "missing"), c: plain }, []),
        { knownToLog: (id) => id === "known" },
      );
      expect(result.deleted.get(repo.dir)).toBe(1);
      expect((await repo.git.listRefs("refs/tide/checkpoints/")).map((r) => r.ref)).toEqual(["refs/tide/checkpoints/stranger/t/after"]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
