import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@tide/contracts";
import { effect, emit } from "../provider/testing/fakeDriver.ts";
import { Git, WORKTREE } from "./git.ts";
import { GIT_TEST_ENV } from "./testing/tempRepo.ts";
import { activitiesOf, harness, newThread, requestTurn, type Harness } from "./testing/vcsHarness.ts";

const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("VcsReactor — worktrees", () => {
  it("creates a worktree for a thread that asked for one and runs the turn inside it", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true, title: "Fix Login" });

    expect(thread.branch).toBe("tide/fix-login");
    expect(thread.baseBranch).toBe("main");
    expect(thread.worktreePath).toBeDefined();

    h.control.script(emit({ type: "settled", status: "completed" }));
    await h.app.engine.dispatch({ type: "turn.request", threadId: thread.id, text: "go" });
    await h.settle();

    expect(h.control.opened[0]?.cwd).toBe(thread.worktreePath);
  });

  it("reports the failure on the first turn and leaves the thread on the project root", async () => {
    const h = await harness(cleanups);
    const dir = await mkdtemp(join(tmpdir(), "tide-plain-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const created = (await h.app.engine.dispatch({ type: "project.create", title: "Plain", rootPath: dir })).events[0]?.event;
    if (created?.type !== "project.created") throw new Error("expected project.created");
    const thread = (
      await h.app.engine.dispatch({ type: "thread.create", projectId: created.project.id, provider: "claude", useWorktree: true })
    ).events[0]?.event;
    if (thread?.type !== "thread.created") throw new Error("expected thread.created");
    await h.settle();
    const threadId = thread.thread.id;
    expect(h.model().threads[threadId]?.worktreePath).toBeUndefined();
    // nothing to say yet: the failure has no turn to hang off
    expect(activitiesOf(h.model(), threadId)).toHaveLength(0);

    h.control.script(emit({ type: "settled", status: "completed" }));
    const first = await requestTurn(h, threadId, "go");
    const errors = activitiesOf(h.model(), threadId).filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ turnId: first });
    expect(errors[0]?.kind === "error" ? errors[0].text : "").toMatch(
      /^Worktree could not be created \(.+\); this thread runs in the project's main checkout — revert and publish are disabled\.$/,
    );

    // and it is said once, not on every turn
    h.control.script(emit({ type: "settled", status: "completed" }));
    await requestTurn(h, threadId, "again");
    expect(activitiesOf(h.model(), threadId).filter((a) => a.kind === "error")).toHaveLength(1);
  });

  it("reopens the harness session in the worktree when one attaches mid-thread", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h);

    h.control.script(emit({ type: "settled", status: "completed" }));
    await requestTurn(h, thread.id, "first");
    expect(h.control.opened).toHaveLength(1);
    expect(h.control.opened[0]?.cwd).toBe(h.repo.dir);

    const info = await h.app.worktrees.create(h.model().projects[thread.projectId]!, thread);
    await h.app.engine.dispatch({
      type: "worktree.attach",
      threadId: thread.id,
      worktreePath: info.worktreePath,
      branch: info.branch,
      baseBranch: info.baseBranch,
    });
    await h.settle();
    expect(h.control.closed).toContain(thread.id);

    h.control.script(emit({ type: "settled", status: "completed" }));
    await requestTurn(h, thread.id, "second");
    expect(h.control.opened).toHaveLength(2);
    expect(h.control.opened[1]?.cwd).toBe(info.worktreePath);
  });

  it("does not create a worktree when the thread did not ask for one", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h);
    expect(thread.worktreePath).toBeUndefined();
    expect(await h.repo.git.worktreeList()).toHaveLength(1);
  });
});

describe("VcsReactor — checkpoints", () => {
  it("snapshots before the turn, after it settles, and reports stats", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true });

    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "agent.txt"), "written by the agent\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    const turnId = await requestTurn(h, thread.id, "write a file");

    const turn = h.model().turns[turnId];
    expect(turn?.checkpoint?.before).toMatch(/^refs\/tide\/checkpoints\//);
    expect(turn?.checkpoint?.after).toMatch(/\/after$/);
    expect(turn?.checkpoint?.stats).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("the before-snapshot precedes the driver's first side effect", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "late.txt"), "x\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    const turnId = await requestTurn(h, thread.id, "go");

    const cwd = h.model().threads[thread.id]?.worktreePath ?? "";
    const before = h.model().turns[turnId]?.checkpoint?.before ?? "";
    const git = new Git(cwd, { env: GIT_TEST_ENV });
    expect((await git.show(before, "late.txt")).missing).toBe(true);
  });

  it("skips checkpoints when the thread's cwd is not a repository", async () => {
    const h = await harness(cleanups);
    const dir = await mkdtemp(join(tmpdir(), "tide-norepo-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const created = (await h.app.engine.dispatch({ type: "project.create", title: "NoRepo", rootPath: dir })).events[0]?.event;
    if (created?.type !== "project.created") throw new Error("expected project.created");
    const thread = (await h.app.engine.dispatch({ type: "thread.create", projectId: created.project.id, provider: "claude" })).events[0]?.event;
    if (thread?.type !== "thread.created") throw new Error("expected thread.created");

    h.control.script(emit({ type: "settled", status: "completed" }));
    const turnId = await requestTurn(h, thread.thread.id, "go");
    expect(h.model().turns[turnId]?.checkpoint).toBeUndefined();
  });
});

describe("VcsReactor — revert", () => {
  it("restores the worktree and posts an info activity", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true });

    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "agent.txt"), "delete me\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    const turnId = await requestTurn(h, thread.id, "write");

    const cwd = h.model().threads[thread.id]?.worktreePath ?? "";
    const git = new Git(cwd, { env: GIT_TEST_ENV });
    expect((await git.show(WORKTREE, "agent.txt")).missing).toBe(false);

    await h.app.engine.dispatch({ type: "thread.revert", threadId: thread.id, turnId });
    await h.settle();

    expect((await git.show(WORKTREE, "agent.txt")).missing).toBe(true);
    const info = activitiesOf(h.model(), thread.id).find((a) => a.kind === "info");
    expect(info).toMatchObject({ kind: "info", text: "Reverted to before turn 1" });
  });

  it("posts an error activity when the checkpoint is gone", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true });
    h.control.script(emit({ type: "settled", status: "completed" }));
    const turnId = await requestTurn(h, thread.id, "go");

    const cwd = h.model().threads[thread.id]?.worktreePath ?? "";
    const ref = h.model().turns[turnId]?.checkpoint?.before ?? "";
    await new Git(cwd, { env: GIT_TEST_ENV }).deleteRef(ref);

    await h.app.engine.dispatch({ type: "thread.revert", threadId: thread.id, turnId });
    await h.settle();
    const error = activitiesOf(h.model(), thread.id).find((a) => a.kind === "error");
    expect(error?.kind === "error" ? error.text : "").toMatch(/Revert failed/);
  });
});

describe("VcsReactor — publish", () => {
  async function withRemote(h: Harness): Promise<string> {
    const bare = await mkdtemp(join(tmpdir(), "tide-origin-"));
    cleanups.push(() => rm(bare, { recursive: true, force: true }));
    await run("git", ["init", "-q", "--bare", bare], { env: GIT_TEST_ENV });
    await h.repo.git.run(["remote", "add", "origin", bare]);
    await h.repo.git.run(["push", "-q", "-u", "origin", "main"]);
    return bare;
  }

  it("commits, pushes and opens a pull request", async () => {
    const h = await harness(cleanups);
    await withRemote(h);
    const thread = await newThread(h, { useWorktree: true, title: "Ship It" });

    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "feature.txt"), "shipped\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, thread.id, "build it");

    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id, title: "feat: ship it", body: "why" });
    await h.settle();

    expect(h.gh.created).toHaveLength(1);
    expect(h.gh.created[0]?.input).toMatchObject({ title: "feat: ship it", body: "why", base: "main", head: "tide/ship-it" });
    expect(h.model().threads[thread.id]?.pr).toMatchObject({ url: "https://github.com/acme/repo/pull/42", number: 42, state: "open" });
    const info = activitiesOf(h.model(), thread.id).find((a) => a.kind === "info");
    expect(info?.kind === "info" ? info.text : "").toBe("Opened pull request #42");
  });

  it("updates an existing pull request instead of creating a second one", async () => {
    const h = await harness(cleanups);
    await withRemote(h);
    h.gh.existing = { url: "https://github.com/acme/repo/pull/7", number: 7, state: "open" };
    const thread = await newThread(h, { useWorktree: true, title: "Again" });

    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "more.txt"), "more\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, thread.id, "go");
    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id });
    await h.settle();

    expect(h.gh.created).toHaveLength(0);
    expect(h.model().threads[thread.id]?.pr).toMatchObject({ number: 7 });
  });

  it("commitOnly commits without touching the remote", async () => {
    const h = await harness(cleanups);
    await withRemote(h);
    const thread = await newThread(h, { useWorktree: true, title: "Local Only" });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "local.txt"), "local\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, thread.id, "go");

    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id, commitOnly: true });
    await h.settle();

    expect(h.gh.created).toHaveLength(0);
    expect(h.model().threads[thread.id]?.pr).toBeUndefined();
    const info = activitiesOf(h.model(), thread.id).find((a) => a.kind === "info");
    expect(info?.kind === "info" ? info.text : "").toMatch(/^Committed [0-9a-f]{8}$/);
  });

  it("reports a missing remote instead of failing", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true, title: "No Remote" });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "x.txt"), "x\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, thread.id, "go");

    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id });
    await h.settle();
    const info = activitiesOf(h.model(), thread.id).find((a) => a.kind === "info");
    expect(info?.kind === "info" ? info.text : "").toMatch(/no remote configured/);
  });

  it("still pushes when gh is not installed", async () => {
    const h = await harness(cleanups);
    await withRemote(h);
    h.gh.available = false;
    const thread = await newThread(h, { useWorktree: true, title: "No Gh" });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "y.txt"), "y\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, thread.id, "go");

    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id });
    await h.settle();
    const info = activitiesOf(h.model(), thread.id).find((a) => a.kind === "info");
    expect(info?.kind === "info" ? info.text : "").toMatch(/install the GitHub CLI/);
  });
});

describe("VcsReactor — worktree teardown", () => {
  /** Thread on a real worktree with a clean tree, ready to be torn down. */
  async function withWorktree(h: Harness, title = "Fix Login"): Promise<Thread> {
    const thread = await newThread(h, { useWorktree: true, title });
    if (thread.worktreePath === undefined) throw new Error("expected a worktree");
    return thread;
  }

  it("archiving removes the worktree directory, keeps the branch and clears the path", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h);
    const { worktreePath, branch } = thread;

    await h.app.engine.dispatch({ type: "thread.archive", threadId: thread.id });
    await h.settle();

    expect(existsSync(worktreePath!)).toBe(false);
    expect((await h.repo.git.worktreeList()).map((w) => w.path)).not.toContain(worktreePath);
    expect(await h.repo.git.revParse(`refs/heads/${branch}`)).toBeDefined();
    expect(h.model().threads[thread.id]?.worktreePath).toBeUndefined();
  });

  it("keepWorktree leaves the checkout on disk", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Keep Me");

    await h.app.engine.dispatch({ type: "thread.archive", threadId: thread.id, keepWorktree: true });
    await h.settle();

    expect(existsSync(thread.worktreePath!)).toBe(true);
    expect(h.model().threads[thread.id]?.worktreePath).toBe(thread.worktreePath);
  });

  it("closes the harness session before the directory goes away", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Session Holder");
    h.control.script(emit({ type: "settled", status: "completed" }));
    await h.app.engine.dispatch({ type: "turn.request", threadId: thread.id, text: "go" });
    await h.settle();
    const closedBefore = h.control.closed.length;

    await h.app.engine.dispatch({ type: "thread.archive", threadId: thread.id });
    await h.settle();
    expect(h.control.closed.length).toBeGreaterThan(closedBefore);
  });

  it("parks uncommitted work on refs/tide/archived/<threadId> before removing a dirty worktree", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Dirty Work");
    await writeFile(join(thread.worktreePath!, "scratch.txt"), "unsaved work\n", "utf8");

    await h.app.engine.dispatch({ type: "thread.archive", threadId: thread.id });
    await h.settle();

    expect(existsSync(thread.worktreePath!)).toBe(false);
    const ref = `refs/tide/archived/${thread.id}`;
    const sha = await h.repo.git.revParse(ref);
    expect(sha).toBeDefined();
    const saved = await h.repo.git.show(sha!, "scratch.txt");
    expect(saved.content).toBe("unsaved work\n");
  });

  it("writes no archive ref when the worktree is clean", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Clean");
    await h.app.engine.dispatch({ type: "thread.archive", threadId: thread.id });
    await h.settle();
    expect(await h.repo.git.revParse(`refs/tide/archived/${thread.id}`)).toBeUndefined();
  });

  it("worktree.detach removes the checkout without archiving the thread", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Detach Only");

    await h.app.engine.dispatch({ type: "worktree.detach", threadId: thread.id });
    await h.settle();

    expect(existsSync(thread.worktreePath!)).toBe(false);
    const after = h.model().threads[thread.id];
    expect(after?.worktreePath).toBeUndefined();
    expect(after?.archivedAt).toBeUndefined();
    expect(await h.repo.git.revParse(`refs/heads/${thread.branch}`)).toBeDefined();
  });

  it("deleteBranch removes a tide/* branch", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Throwaway");
    expect(thread.branch).toBe("tide/throwaway");

    await h.app.engine.dispatch({ type: "worktree.detach", threadId: thread.id, deleteBranch: true });
    await h.settle();

    expect(await h.repo.git.revParse("refs/heads/tide/throwaway")).toBeUndefined();
  });

  it("refuses to delete a branch Tide does not own", async () => {
    const h = await harness(cleanups);
    const thread = await withWorktree(h, "Foreign");
    // the thread is re-pointed at a branch that is not Tide's to remove
    await run("git", ["-C", h.repo.dir, "branch", "feature/keepme"], { env: GIT_TEST_ENV });
    await h.app.engine.dispatch({
      type: "worktree.attach",
      threadId: thread.id,
      worktreePath: thread.worktreePath!,
      branch: "feature/keepme",
    });
    await h.settle();

    await h.app.engine.dispatch({ type: "worktree.detach", threadId: thread.id, deleteBranch: true });
    await h.settle();

    expect(existsSync(thread.worktreePath!)).toBe(false);
    expect(await h.repo.git.revParse("refs/heads/feature/keepme")).toBeDefined();
  });
});
