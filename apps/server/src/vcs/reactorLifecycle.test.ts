import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { awaitApproval, effect, emit } from "../provider/testing/fakeDriver.ts";
import { Git } from "./git.ts";
import { GIT_TEST_ENV } from "./testing/tempRepo.ts";
import { activitiesOf, harness, newThread, requestTurn } from "./testing/vcsHarness.ts";

const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("VcsReactor — checkpoint ref lifetime", () => {
  async function twoThreads(h: Awaited<ReturnType<typeof harness>>) {
    const a = await newThread(h, { useWorktree: true, title: "Mine" });
    const b = await newThread(h, { useWorktree: true, title: "Other" });
    for (const t of [a, b]) {
      h.control.script(
        effect(async (options) => {
          await writeFile(join(options.cwd, "w.txt"), "w\n", "utf8");
        }),
        emit({ type: "settled", status: "completed" }),
      );
      await requestTurn(h, t.id, "go");
    }
    return { a, b };
  }
  const refs = (h: Awaited<ReturnType<typeof harness>>, id: string) => h.repo.git.listRefs(`refs/tide/checkpoints/${id}/`);

  it("archive with keepWorktree then unarchive keeps refs, and the turn diff still works", async () => {
    const h = await harness(cleanups);
    const { a } = await twoThreads(h);
    await h.app.engine.dispatch({ type: "thread.archive", threadId: a.id, keepWorktree: true });
    await h.settle();
    await h.app.engine.dispatch({ type: "thread.unarchive", threadId: a.id });
    await h.settle();
    expect((await refs(h, a.id)).length).toBe(2);
    const turn = Object.values(h.model().turns).find((t) => t.threadId === a.id)!;
    const diff = await h.app.checkpoints.turnDiff(a.worktreePath!, turn);
    expect(diff.files.map((f) => f.path)).toEqual(["w.txt"]);
  });

  it("archive without keepWorktree removes the directory but refs still serve the turn diff", async () => {
    const h = await harness(cleanups);
    const { a, b } = await twoThreads(h);
    await h.app.engine.dispatch({ type: "thread.archive", threadId: a.id });
    await h.settle();
    await h.app.engine.dispatch({ type: "thread.unarchive", threadId: a.id });
    await h.settle();
    expect(existsSync(a.worktreePath!)).toBe(false);
    expect((await refs(h, a.id)).length).toBe(2);
    expect((await refs(h, b.id)).length).toBe(2);
    const turn = Object.values(h.model().turns).find((t) => t.threadId === a.id)!;
    const diff = await h.app.checkpoints.turnDiff(h.repo.dir, turn);
    expect(diff.files.map((f) => f.path)).toEqual(["w.txt"]);
  });

  it("detach with deleteBranch removes that thread's refs only", async () => {
    const h = await harness(cleanups);
    const { a, b } = await twoThreads(h);
    await h.app.engine.dispatch({ type: "worktree.detach", threadId: a.id, deleteBranch: true });
    await h.settle();
    expect(await refs(h, a.id)).toEqual([]);
    expect((await refs(h, b.id)).length).toBe(2);
  });
});

describe("VcsReactor — thread.delete", () => {
  async function withWork(h: Awaited<ReturnType<typeof harness>>, title: string) {
    const t = await newThread(h, { useWorktree: true, title });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "w.txt"), "w\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, t.id, "go");
    return t;
  }

  it("an archived thread loses its branch, checkpoint refs and archived-work ref", async () => {
    const h = await harness(cleanups);
    const a = await withWork(h, "Gone Soon");
    const b = await withWork(h, "Stays");
    // dirty at archive time: the work is parked on refs/tide/archived/<id>
    await writeFile(join(a.worktreePath!, "scratch.txt"), "unsaved\n", "utf8");
    await h.app.engine.dispatch({ type: "thread.archive", threadId: a.id });
    await h.settle();
    expect(existsSync(a.worktreePath!)).toBe(false);
    expect(await h.repo.git.revParse(`refs/tide/archived/${a.id}`)).toBeDefined();

    await h.app.engine.dispatch({ type: "thread.delete", threadId: a.id });
    await h.settle();

    expect(h.model().threads[a.id]).toBeUndefined();
    expect(Object.values(h.model().turns).filter((t) => t.threadId === a.id)).toEqual([]);
    expect(await h.repo.git.revParse("refs/heads/tide/gone-soon")).toBeUndefined();
    expect(await h.repo.git.listRefs(`refs/tide/checkpoints/${a.id}/`)).toEqual([]);
    expect(await h.repo.git.revParse(`refs/tide/archived/${a.id}`)).toBeUndefined();
    // the neighbour is untouched
    expect(existsSync(b.worktreePath!)).toBe(true);
    expect(await h.repo.git.revParse(`refs/heads/${b.branch}`)).toBeDefined();
    expect((await h.repo.git.listRefs(`refs/tide/checkpoints/${b.id}/`)).length).toBe(2);
  });

  it("a live thread loses its worktree directory, session and branch", async () => {
    const h = await harness(cleanups);
    const a = await withWork(h, "Live Delete");
    const closedBefore = h.control.closed.length;

    await h.app.engine.dispatch({ type: "thread.delete", threadId: a.id });
    await h.settle();

    expect(h.model().threads[a.id]).toBeUndefined();
    expect(existsSync(a.worktreePath!)).toBe(false);
    expect((await h.repo.git.worktreeList()).map((w) => w.path)).not.toContain(a.worktreePath);
    expect(await h.repo.git.revParse("refs/heads/tide/live-delete")).toBeUndefined();
    expect(await h.repo.git.listRefs(`refs/tide/checkpoints/${a.id}/`)).toEqual([]);
    expect(h.control.closed.length).toBeGreaterThan(closedBefore);
  });
});

describe("VcsReactor — thread.delete cascade", () => {
  it("removes a checkout shared by a lead and its delegate once, with its branch, and logs no failure", async () => {
    const logs: string[] = [];
    const h = await harness(cleanups, { log: (msg) => logs.push(msg) });
    const lead = await newThread(h, { useWorktree: true, title: "Lead Work" });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "w.txt"), "w\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, lead.id, "go");
    h.control.script(emit({ type: "settled", status: "completed" }));
    const delegated = await h.app.engine.dispatch({ type: "thread.delegate", fromThreadId: lead.id, provider: "claude", prompt: "review", inheritWorktreeFrom: lead.id });
    await h.settle();
    const created = delegated.events.find((r) => r.event.type === "thread.created")?.event;
    if (created?.type !== "thread.created") throw new Error("expected thread.created");
    const delegate = h.model().threads[created.thread.id]!;
    expect(delegate.worktreePath).toBe(lead.worktreePath);
    expect(delegate.status).not.toBe("running");

    logs.length = 0;
    const result = await h.app.engine.dispatch({ type: "thread.delete", threadId: lead.id, cascade: true });
    expect(result.events.map((r) => (r.event.type === "thread.deleted" ? r.event.threadId : r.event.type))).toEqual([delegate.id, lead.id]);
    await h.settle();

    expect(h.model().threads[lead.id]).toBeUndefined();
    expect(h.model().threads[delegate.id]).toBeUndefined();
    expect(existsSync(lead.worktreePath!)).toBe(false);
    expect((await h.repo.git.worktreeList()).map((w) => w.path)).not.toContain(lead.worktreePath);
    expect(await h.repo.git.revParse(`refs/heads/${lead.branch}`)).toBeUndefined();
    expect(await h.repo.git.listRefs(`refs/tide/checkpoints/${lead.id}/`)).toEqual([]);
    expect(logs.filter((m) => /fail|could not|kept|refusing/.test(m))).toEqual([]);
  });
});

describe("VcsReactor — detach failures surface on the thread", () => {
  it("keeps a worktree whose uncommitted work cannot be preserved, and says so", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true, title: "Unreadable" });
    h.control.script(emit({ type: "settled", status: "completed" }));
    await requestTurn(h, thread.id, "go");
    const locked = join(thread.worktreePath!, "locked.txt");
    await writeFile(locked, "secret\n", "utf8");
    await chmod(locked, 0o000);
    cleanups.push(() => chmod(locked, 0o644).catch(() => undefined));

    await h.app.engine.dispatch({ type: "worktree.detach", threadId: thread.id });
    await h.settle();

    expect(existsSync(thread.worktreePath!)).toBe(true);
    expect(h.model().threads[thread.id]?.worktreePath).toBe(thread.worktreePath);
    const error = activitiesOf(h.model(), thread.id).find((a) => a.kind === "error");
    expect(error?.kind === "error" ? error.text : "").toMatch(/^Worktree kept: its uncommitted work could not be preserved/);
  });
});

describe("VcsReactor — queued turns", () => {
  it("snapshots a queued turn when it is promoted, after the turn ahead of it finished editing", async () => {
    const h = await harness(cleanups);
    const thread = await newThread(h, { useWorktree: true, title: "Queue" });
    h.control.script(
      awaitApproval("hold"),
      effect(async (options) => {
        await writeFile(join(options.cwd, "first.txt"), "1\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    h.control.script(emit({ type: "settled", status: "completed" }));
    const first = (await h.app.engine.dispatch({ type: "turn.request", threadId: thread.id, text: "one" })).events.at(-1)?.event;
    const second = (await h.app.engine.dispatch({ type: "turn.request", threadId: thread.id, text: "two" })).events.at(-1)?.event;
    if (first?.type !== "turn.requested" || second?.type !== "turn.requested") throw new Error("expected turn.requested");
    expect(second.turn.status).toBe("queued");
    await h.app.vcs.drain();
    expect(h.model().turns[second.turn.id]?.checkpoint).toBeUndefined();

    await h.control.sessionFor(thread.id)?.respondApproval("hold", "accept");
    await h.settle();

    const before = h.model().turns[second.turn.id]?.checkpoint?.before;
    expect(before).toBeDefined();
    // the second turn's baseline already contains what the first turn wrote
    const git = new Git(thread.worktreePath!, { env: GIT_TEST_ENV });
    expect((await git.show(before!, "first.txt")).content).toBe("1\n");
  });
});

describe("VcsReactor — publish mergeWhenGreen", () => {
  it("enables GitHub auto-merge on the PR it opened", async () => {
    const h = await harness(cleanups);
    const bare = await mkdtemp(join(tmpdir(), "tide-origin-"));
    cleanups.push(() => rm(bare, { recursive: true, force: true }));
    await run("git", ["init", "-q", "--bare", bare], { env: GIT_TEST_ENV });
    await h.repo.git.run(["remote", "add", "origin", bare]);
    await h.repo.git.run(["push", "-q", "-u", "origin", "main"]);
    const thread = await newThread(h, { useWorktree: true, title: "Green" });
    h.control.script(
      effect(async (options) => {
        await writeFile(join(options.cwd, "green.txt"), "g\n", "utf8");
      }),
      emit({ type: "settled", status: "completed" }),
    );
    await requestTurn(h, thread.id, "go");

    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id, mergeWhenGreen: "squash" });
    await h.settle();

    expect(h.gh.merged).toEqual([{ cwd: thread.worktreePath, number: 42, input: { strategy: "squash", auto: true } }]);
    expect(activitiesOf(h.model(), thread.id).some((a) => a.kind === "info" && a.text === "Auto-merge (squash) enabled on pull request #42")).toBe(true);
  });
});
