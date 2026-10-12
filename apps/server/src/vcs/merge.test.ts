import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MergeStrategy, Thread } from "@tide/contracts";
import { effect, emit } from "../provider/testing/fakeDriver.ts";
import { Git } from "./git.ts";
import { GIT_TEST_ENV } from "./testing/tempRepo.ts";
import { activitiesOf, harness, newThread, requestTurn, type Harness } from "./testing/vcsHarness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A worktree thread whose one turn wrote `file` (left uncommitted, as agents usually do). */
async function threadWithWork(h: Harness, title: string, file: string, content: string): Promise<Thread> {
  const thread = await newThread(h, { useWorktree: true, title });
  h.control.script(
    effect(async (options) => {
      await writeFile(join(options.cwd, file), content, "utf8");
    }),
    emit({ type: "settled", status: "completed" }),
  );
  await requestTurn(h, thread.id, "work");
  return h.model().threads[thread.id] as Thread;
}

async function merge(h: Harness, threadId: string, strategy: MergeStrategy, deleteBranch = false): Promise<void> {
  await h.app.engine.dispatch({ type: "thread.merge", threadId, strategy, ...(deleteBranch ? { deleteBranch: true } : {}) });
  await h.settle();
}

const parents = async (git: Git, ref: string): Promise<number> => (await git.run(["rev-list", "--parents", "-n", "1", ref])).trim().split(" ").length - 1;

describe("merge-back — local", () => {
  it("squash-merges into the base and fast-forwards a clean main checkout", async () => {
    const h = await harness(cleanups);
    const before = await h.repo.git.revParse("refs/heads/main");
    const thread = await threadWithWork(h, "Add Feature", "feature.txt", "feature\n");

    await merge(h, thread.id, "squash");

    const after = h.model().threads[thread.id];
    expect(after?.merge).toMatchObject({ status: "merged", strategy: "squash" });
    expect(after?.mergedAt).toBeDefined();
    const main = await h.repo.git.revParse("refs/heads/main");
    expect(main).not.toBe(before);
    expect(after?.merge?.sha).toBe(main);
    expect(await parents(h.repo.git, "main")).toBe(1);
    expect((await h.repo.git.show("main", "feature.txt")).content).toBe("feature\n");
    // clean checkout on main: fast-forwarded, files and all
    expect(await readFile(join(h.repo.dir, "feature.txt"), "utf8")).toBe("feature\n");
    expect((await h.repo.git.status()).dirty).toBe(0);
    // the thread keeps its branch and worktree unless asked otherwise
    expect(await h.repo.git.revParse(`refs/heads/${thread.branch}`)).toBeDefined();
    expect(existsSync(thread.worktreePath!)).toBe(true);
    expect(existsSync(h.app.worktrees.root + `/.merge-${thread.id}`)).toBe(false);
  });

  it("never touches a dirty main checkout: only the ref moves, and the note says so", async () => {
    const h = await harness(cleanups);
    const thread = await threadWithWork(h, "Dirty Base", "feature.txt", "feature\n");
    await writeFile(join(h.repo.dir, "README.md"), "# my unsaved edit\n", "utf8");

    await merge(h, thread.id, "squash");

    expect(h.model().threads[thread.id]?.merge?.status).toBe("merged");
    expect((await h.repo.git.show("main", "feature.txt")).content).toBe("feature\n");
    // the user's files are exactly as they left them
    expect(await readFile(join(h.repo.dir, "README.md"), "utf8")).toBe("# my unsaved edit\n");
    expect(existsSync(join(h.repo.dir, "feature.txt"))).toBe(false);
    const info = activitiesOf(h.model(), thread.id).find((a) => a.kind === "info" && a.text.startsWith("Merged"));
    expect(info?.kind === "info" ? info.text : "").toMatch(/uncommitted changes/);
  });

  it("reports conflicting files, leaves base and thread untouched, and merges on retry once resolved", async () => {
    const h = await harness(cleanups);
    const thread = await threadWithWork(h, "Clash", "README.md", "# thread version\n");
    // main moves on with a conflicting edit
    await h.repo.write("README.md", "# main version\n");
    const mainSha = await h.repo.commit("main edit");

    await merge(h, thread.id, "squash");

    const conflicted = h.model().threads[thread.id];
    expect(conflicted?.merge).toMatchObject({ status: "conflicted", files: ["README.md"] });
    expect(conflicted?.mergedAt).toBeUndefined();
    expect(await h.repo.git.revParse("refs/heads/main")).toBe(mainSha);
    expect((await h.repo.git.worktreeList()).some((w) => w.path.includes(".merge-"))).toBe(false);
    expect(activitiesOf(h.model(), thread.id).some((a) => a.kind === "error" && a.text.includes("README.md"))).toBe(true);

    // the user resolves on the thread's branch (keeping the thread's version) and retries
    const wt = new Git(thread.worktreePath!, { env: GIT_TEST_ENV });
    await wt.run(["merge", "-q", "-s", "ours", "main", "-m", "resolve"]);
    await merge(h, thread.id, "squash");

    expect(h.model().threads[thread.id]?.merge?.status).toBe("merged");
    expect((await h.repo.git.show("main", "README.md")).content).toBe("# thread version\n");
  });

  it("merge keeps both parents; rebase lands linear history", async () => {
    const h = await harness(cleanups);
    const a = await threadWithWork(h, "Merge Me", "a.txt", "a\n");
    await merge(h, a.id, "merge");
    expect(h.model().threads[a.id]?.merge?.status).toBe("merged");
    expect(await parents(h.repo.git, "main")).toBe(2);

    const b = await threadWithWork(h, "Rebase Me", "b.txt", "b\n");
    await merge(h, b.id, "rebase");
    expect(h.model().threads[b.id]?.merge?.status).toBe("merged");
    expect(await parents(h.repo.git, "main")).toBe(1);
    expect((await h.repo.git.show("main", "a.txt")).content).toBe("a\n");
    expect((await h.repo.git.show("main", "b.txt")).content).toBe("b\n");
  });

  it("deleteBranch removes the tide branch, the worktree and the thread's checkpoint refs", async () => {
    const h = await harness(cleanups);
    const thread = await threadWithWork(h, "Throw Away", "x.txt", "x\n");
    const prefix = `refs/tide/checkpoints/${thread.id}/`;
    expect((await h.repo.git.listRefs(prefix)).length).toBeGreaterThan(0);

    await merge(h, thread.id, "squash", true);

    const after = h.model().threads[thread.id];
    expect(after?.merge?.status).toBe("merged");
    expect(after?.worktreePath).toBeUndefined();
    expect(existsSync(thread.worktreePath!)).toBe(false);
    expect(await h.repo.git.revParse(`refs/heads/${thread.branch}`)).toBeUndefined();
    expect(await h.repo.git.listRefs(prefix)).toEqual([]);
    expect((await h.repo.git.show("main", "x.txt")).content).toBe("x\n");
  });
});

describe("merge-back — via the pull request", () => {
  it("merges through gh when the thread has an open PR and records it as merged", async () => {
    const h = await harness(cleanups);
    const thread = await threadWithWork(h, "Via Pr", "pr.txt", "pr\n");
    await h.app.engine.dispatch({
      type: "pr.update",
      threadId: thread.id,
      pr: { url: "https://github.com/acme/repo/pull/9", number: 9, state: "open", updatedAt: 1 },
    });
    const mainBefore = await h.repo.git.revParse("refs/heads/main");

    await merge(h, thread.id, "rebase");

    expect(h.gh.merged).toEqual([{ cwd: h.repo.dir, number: 9, input: { strategy: "rebase" } }]);
    const after = h.model().threads[thread.id];
    expect(after?.pr?.state).toBe("merged");
    expect(after?.merge?.status).toBe("merged");
    expect(after?.mergedAt).toBeDefined();
    // GitHub did the merge: the local base is not moved by Tide
    expect(await h.repo.git.revParse("refs/heads/main")).toBe(mainBefore);
  });

  it("reports an error when the PR does not end up merged", async () => {
    const h = await harness(cleanups);
    h.gh.stateAfterMerge = "closed";
    const thread = await threadWithWork(h, "Closed Pr", "c.txt", "c\n");
    await h.app.engine.dispatch({
      type: "pr.update",
      threadId: thread.id,
      pr: { url: "https://github.com/acme/repo/pull/5", number: 5, state: "open", updatedAt: 1 },
    });
    await merge(h, thread.id, "squash");
    expect(h.model().threads[thread.id]?.merge).toMatchObject({ status: "error", error: expect.stringContaining("#5") });
  });
});
