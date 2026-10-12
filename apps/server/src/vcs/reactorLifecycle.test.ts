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

describe("VcsReactor — checkpoint ref GC", () => {
  it("archiving a thread deletes its checkpoint refs and nobody else's", async () => {
    const h = await harness(cleanups);
    const a = await newThread(h, { useWorktree: true, title: "Gone" });
    const b = await newThread(h, { useWorktree: true, title: "Stays" });
    for (const t of [a, b]) {
      h.control.script(emit({ type: "settled", status: "completed" }));
      await requestTurn(h, t.id, "go");
    }
    expect((await h.repo.git.listRefs(`refs/tide/checkpoints/${a.id}/`)).length).toBe(2);

    await h.app.engine.dispatch({ type: "thread.archive", threadId: a.id, keepWorktree: true });
    await h.settle();

    expect(await h.repo.git.listRefs(`refs/tide/checkpoints/${a.id}/`)).toEqual([]);
    expect((await h.repo.git.listRefs(`refs/tide/checkpoints/${b.id}/`)).length).toBe(2);
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
    const first = (await h.app.engine.dispatch({ type: "turn.request", threadId: thread.id, text: "one" })).events[0]?.event;
    const second = (await h.app.engine.dispatch({ type: "turn.request", threadId: thread.id, text: "two" })).events[0]?.event;
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
