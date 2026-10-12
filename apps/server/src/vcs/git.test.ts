import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKTREE } from "./git.ts";
import { createTempRepo, type TempRepo } from "./testing/tempRepo.ts";

const repos: TempRepo[] = [];
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo();
  repos.push(r);
  return r;
}
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

describe("Git — repo state", () => {
  it("reports repo, branch, status and remote", async () => {
    const r = await repo();
    expect(await r.git.isRepo()).toBe(true);
    expect(await r.git.currentBranch()).toBe("main");
    expect((await r.git.status()).dirty).toBe(0);
    await r.write("a.txt", "hello\n");
    expect((await r.git.status()).dirty).toBe(1);
    expect(await r.git.hasRemote()).toBe(false);
    expect(await r.git.revParse("HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(await r.git.revParse("refs/heads/nope")).toBeUndefined();
  });

  it("show never parses a ref as an option", async () => {
    const r = await repo();
    const out = join(r.dir, "pwned.txt");
    expect((await r.git.show(`--output=${out}`, "README.md")).missing).toBe(true);
    expect(existsSync(out)).toBe(false);
    expect((await r.git.show("HEAD", "README.md")).content).toBe("# temp\n");
  });

  it("isRepo is false outside a repository", async () => {
    const r = await repo();
    expect(await r.git.at("/").isRepo()).toBe(false);
  });
});

describe("Git — snapshot", () => {
  it("captures untracked files without touching index or HEAD", async () => {
    const r = await repo();
    const headBefore = await r.git.revParse("HEAD");
    await r.write("tracked.txt", "changed\n");
    await r.write("brand-new.txt", "fresh\n");
    const sha = await r.git.snapshot();

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await r.git.revParse("HEAD")).toBe(headBefore);
    // index untouched: nothing is staged
    expect((await r.git.tryRun(["diff", "--cached", "--quiet"])).code).toBe(0);
    expect((await r.git.show(sha, "brand-new.txt")).content).toBe("fresh\n");
    expect((await r.git.show(sha, "tracked.txt")).content).toBe("changed\n");
    expect((await r.git.show(headBefore ?? "", "brand-new.txt")).missing).toBe(true);
  });

  it("respects .gitignore", async () => {
    const r = await repo();
    await r.write(".gitignore", "ignored/\n");
    await r.commit("ignore");
    await r.write("ignored/secret.txt", "nope\n");
    const sha = await r.git.snapshot();
    expect((await r.git.show(sha, "ignored/secret.txt")).missing).toBe(true);
  });

  it("records deletions", async () => {
    const r = await repo();
    await r.write("gone.txt", "x\n");
    await r.commit("add gone");
    await r.remove("gone.txt");
    const sha = await r.git.snapshot();
    expect((await r.git.show(sha, "gone.txt")).missing).toBe(true);
  });
});

describe("Git — diff", () => {
  it("parses modified, added, deleted and renamed files", async () => {
    const r = await repo();
    await r.write("keep.txt", "a\nb\nc\n");
    await r.write("old-name.txt", "the quick brown fox\njumps over\nthe lazy dog\nagain and again\n");
    await r.write("doomed.txt", "bye\n");
    const base = await r.commit("base");

    await r.write("keep.txt", "a\nB\nc\n");
    await r.remove("doomed.txt");
    await r.remove("old-name.txt");
    await r.write("new-name.txt", "the quick brown fox\njumps over\nthe lazy dog\nagain and again\n");
    await r.write("added.txt", "brand new\n");
    const head = await r.commit("changes");

    const files = await r.git.diff(base, head);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("keep.txt")?.status).toBe("modified");
    expect(byPath.get("keep.txt")).toMatchObject({ additions: 1, deletions: 1 });
    expect(byPath.get("keep.txt")?.patch).toContain("-b");
    expect(byPath.get("added.txt")?.status).toBe("added");
    expect(byPath.get("doomed.txt")?.status).toBe("deleted");
    const renamed = byPath.get("new-name.txt");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("old-name.txt");
  });

  it("marks binary files and omits their patch", async () => {
    const r = await repo();
    const base = await r.git.revParse("HEAD");
    await r.writeBytes("blob.bin", Buffer.from([0, 1, 2, 3, 0, 255, 7]));
    const head = await r.commit("binary");
    const file = (await r.git.diff(base ?? "", head)).find((f) => f.path === "blob.bin");
    expect(file?.binary).toBe(true);
    expect(file?.patch).toBeUndefined();
  });

  it("diffs against the working tree including untracked files", async () => {
    const r = await repo();
    await r.write("tracked.txt", "one\n");
    const base = await r.commit("base");
    await r.write("tracked.txt", "one\ntwo\n");
    await r.write("untracked.txt", "hello\nworld\n");

    const files = await r.git.diff(base, WORKTREE);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("tracked.txt")).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(byPath.get("untracked.txt")).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath.get("untracked.txt")?.patch).toContain("+hello");
  });

  it("stat mode omits patches", async () => {
    const r = await repo();
    const base = await r.git.revParse("HEAD");
    await r.write("x.txt", "y\n");
    const files = await r.git.diff(base ?? "", WORKTREE, { stat: true });
    expect(files[0]?.patch).toBeUndefined();
    expect(files[0]?.additions).toBe(1);
  });

  it("caps very large patches", async () => {
    const r = await repo();
    const base = await r.git.revParse("HEAD");
    await r.write("big.txt", "x".repeat(64) + "\n");
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
    await r.write("big.txt", lines);
    const files = await r.git.diff(base ?? "", WORKTREE);
    expect(files[0]?.patch).toContain("patch truncated");
  });
});

describe("Git — checkoutTree", () => {
  it("restores modified files and deletes files added after the snapshot", async () => {
    const r = await repo();
    await r.write("keep.txt", "original\n");
    await r.commit("base");
    const snap = await r.git.snapshot();

    await r.write("keep.txt", "mutated\n");
    await r.write("added-after.txt", "should vanish\n");
    await r.write("nested/deep.txt", "also gone\n");
    await r.commit("agent work");

    await r.git.checkoutTree(snap);
    const names = await readdir(r.dir);
    expect(names).not.toContain("added-after.txt");
    expect(names).not.toContain("nested");
    expect((await r.git.show(WORKTREE, "keep.txt")).content).toBe("original\n");
    // HEAD is untouched: the agent's commit is still there
    expect((await r.git.run(["log", "--oneline"])).split("\n").filter(Boolean).length).toBe(3);
  });

  it("keeps ignored files", async () => {
    const r = await repo();
    await r.write(".gitignore", "node_modules/\n");
    await r.commit("ignore");
    const snap = await r.git.snapshot();
    await r.write("node_modules/dep.js", "cached\n");
    await r.write("new.txt", "x\n");
    await r.git.checkoutTree(snap);
    expect((await r.git.show(WORKTREE, "node_modules/dep.js")).content).toBe("cached\n");
    expect((await r.git.show(WORKTREE, "new.txt")).missing).toBe(true);
  });
});

describe("Git — worktrees", () => {
  it("adds, lists and removes a worktree", async () => {
    const r = await repo();
    const path = `${r.dir}-wt`;
    await r.git.worktreeAdd(path, "tide/feature", "main");
    const list = await r.git.worktreeList();
    expect(list.map((w) => w.branch)).toContain("tide/feature");
    expect(await r.git.at(path).currentBranch()).toBe("tide/feature");
    await r.git.worktreeRemove(path, true);
    expect((await r.git.worktreeList()).map((w) => w.branch)).not.toContain("tide/feature");
  });
});

describe("Git — refs, commit, show", () => {
  it("updates, lists and deletes refs", async () => {
    const r = await repo();
    const sha = (await r.git.revParse("HEAD")) ?? "";
    await r.git.updateRef("refs/tide/checkpoints/t1/u1/before", sha);
    expect(await r.git.listRefs("refs/tide/checkpoints/t1")).toEqual([
      { ref: "refs/tide/checkpoints/t1/u1/before", sha },
    ]);
    await r.git.deleteRef("refs/tide/checkpoints/t1/u1/before");
    expect(await r.git.listRefs("refs/tide/checkpoints/t1")).toEqual([]);
  });

  it("commitAll commits everything and returns undefined when clean", async () => {
    const r = await repo();
    await r.write("new.txt", "hi\n");
    const sha = await r.git.commitAll("tide: work");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await r.git.commitAll("tide: nothing")).toBeUndefined();
  });

  it("show reports binary and missing files", async () => {
    const r = await repo();
    await r.writeBytes("b.bin", Buffer.from([0, 1, 2]));
    await r.commit("bin");
    const head = (await r.git.revParse("HEAD")) ?? "";
    expect(await r.git.show(head, "b.bin")).toMatchObject({ binary: true, missing: false });
    expect(await r.git.show(head, "nope.txt")).toMatchObject({ missing: true });
    expect((await r.git.show(WORKTREE, "README.md")).content).toBe("# temp\n");
  });
});
