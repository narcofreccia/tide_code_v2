import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest, GitSettings, ProviderInstance, Thread } from "@tide/contracts";
import { effect, emit } from "../provider/testing/fakeDriver.ts";
import { Git } from "./git.ts";
import { GIT_TEST_ENV } from "./testing/tempRepo.ts";
import { activitiesOf, harness, newThread, requestTurn, type Harness } from "./testing/vcsHarness.ts";

const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The harness repo is machine A; `origin` is bare and `b` is a second clone ("another machine"). */
interface Remote {
  origin: string;
  b: Git;
  bDir: string;
}

async function withOrigin(h: Harness): Promise<Remote> {
  const origin = await mkdtemp(join(tmpdir(), "tide-origin-"));
  const bDir = await mkdtemp(join(tmpdir(), "tide-machine-b-"));
  cleanups.push(() => rm(origin, { recursive: true, force: true }), () => rm(bDir, { recursive: true, force: true }));
  await run("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: GIT_TEST_ENV });
  await h.repo.git.run(["remote", "add", "origin", origin]);
  await h.repo.git.run(["push", "-q", "-u", "origin", "main"]);
  await rm(bDir, { recursive: true, force: true });
  await run("git", ["clone", "-q", origin, bDir], { env: GIT_TEST_ENV });
  return { origin, b: new Git(bDir, { env: GIT_TEST_ENV }), bDir };
}

async function bCommitsToMain(r: Remote, file: string): Promise<string> {
  await writeFile(join(r.bDir, file), "from b\n", "utf8");
  await r.b.run(["add", "-A"]);
  await r.b.run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", `b: ${file}`]);
  await r.b.run(["push", "-q", "origin", "main"]);
  return (await r.b.revParse("HEAD")) ?? "";
}

const remoteSha = async (r: Remote, ref: string): Promise<string | undefined> =>
  (await r.b.run(["ls-remote", "origin", ref])).split("\t")[0] || undefined;

function setGit(h: Harness, git: Partial<GitSettings>): void {
  h.app.settings.set({ git });
}

/** One turn writing `file` and committing it, so the branch itself moves. */
async function committedTurn(h: Harness, threadId: string, file: string): Promise<void> {
  h.control.script(
    effect(async (options) => {
      await writeFile(join(options.cwd, file), `${file}\n`, "utf8");
      const wt = new Git(options.cwd, { env: GIT_TEST_ENV });
      await wt.run(["add", "-A"]);
      await wt.run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", file]);
    }),
    emit({ type: "settled", status: "completed" }),
  );
  await requestTurn(h, threadId, "work");
}

async function uncommittedTurn(h: Harness, threadId: string, file: string): Promise<void> {
  h.control.script(
    effect(async (options) => {
      await writeFile(join(options.cwd, file), `${file}\n`, "utf8");
    }),
    emit({ type: "settled", status: "completed" }),
  );
  await requestTurn(h, threadId, "work");
}

async function merge(h: Harness, threadId: string): Promise<Thread> {
  await h.app.engine.dispatch({ type: "thread.merge", threadId, strategy: "squash" });
  await h.settle();
  return h.model().threads[threadId] as Thread;
}

const texts = (h: Harness, threadId: string, kind: "info" | "error"): string[] =>
  activitiesOf(h.model(), threadId).flatMap((a) => (a.kind === kind ? [a.text] : []));

describe("B4 — thread branches through origin", { timeout: 20_000 }, () => {
  it("on-checkpoint pushes the branch after each turn and records branch.pushed", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { pushThreadBranches: "on-checkpoint" });
    const thread = await newThread(h, { useWorktree: true, title: "Push Me" });
    await committedTurn(h, thread.id, "one.txt");

    const sha = await h.repo.git.revParse(`refs/heads/${thread.branch}`);
    expect(h.model().threads[thread.id]).toMatchObject({ remoteBranch: "tide/push-me", pushedSha: sha });
    expect(await remoteSha(r, "refs/heads/tide/push-me")).toBe(sha);

    await committedTurn(h, thread.id, "two.txt");
    const next = await h.repo.git.revParse(`refs/heads/${thread.branch}`);
    expect(next).not.toBe(sha);
    expect(h.model().threads[thread.id]?.pushedSha).toBe(next);
  });

  it("never (the default) pushes nothing", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    const thread = await newThread(h, { useWorktree: true, title: "Stay Home" });
    await committedTurn(h, thread.id, "one.txt");
    await merge(h, thread.id);
    expect(h.model().threads[thread.id]?.remoteBranch).toBeUndefined();
    expect(await remoteSha(r, "refs/heads/tide/stay-home")).toBeUndefined();
  });

  it("a failing push is said once until the next success", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { pushThreadBranches: "on-checkpoint" });
    const thread = await newThread(h, { useWorktree: true, title: "Offline" });
    await h.repo.git.run(["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    await committedTurn(h, thread.id, "one.txt");
    await committedTurn(h, thread.id, "two.txt");
    expect(texts(h, thread.id, "info").filter((t) => t.startsWith("Could not push tide/offline to origin"))).toHaveLength(1);
    expect(h.model().threads[thread.id]?.remoteBranch).toBeUndefined();

    await h.repo.git.run(["remote", "set-url", "origin", r.origin]);
    await committedTurn(h, thread.id, "three.txt");
    expect(h.model().threads[thread.id]?.remoteBranch).toBe("tide/offline");
  });

  it("on-merge-request commits pending work and pushes the branch before merging", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { pushThreadBranches: "on-merge-request" });
    const thread = await newThread(h, { useWorktree: true, title: "Hand Off" });
    await uncommittedTurn(h, thread.id, "work.txt");
    expect(h.model().threads[thread.id]?.remoteBranch).toBeUndefined();

    const after = await merge(h, thread.id);
    expect(after.merge?.status).toBe("merged");
    const pushed = await remoteSha(r, "refs/heads/tide/hand-off");
    expect(pushed).toBe(after.pushedSha);
    expect((await new Git(r.origin, { env: GIT_TEST_ENV }).run(["show", `${pushed}:work.txt`])).trim()).toBe("work.txt");
  });
});

describe("B4 — merge back against origin", { timeout: 20_000 }, () => {
  it("by default fast-forwards a stale base from origin first and leaves origin's base alone", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    const fromB = await bCommitsToMain(r, "b.txt");

    const after = await merge(h, thread.id);
    expect(after.merge?.status).toBe("merged");
    expect(after.mergedAt).toBeDefined();
    expect(await h.repo.git.run(["merge-base", "--is-ancestor", fromB, "main"])).toBe("");
    expect((await h.repo.git.show("main", "feature.txt")).content).toBe("feature.txt\n");
    expect(await remoteSha(r, "refs/heads/main")).toBe(fromB);
    expect(texts(h, thread.id, "info").at(-1)).toMatch(/main fast-forwarded to origin \(1 new commit\)/);
    expect(texts(h, thread.id, "error")).toEqual([]);
  });

  it("pushBaseAfterMerge pushes the merged base to origin", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { pushBaseAfterMerge: true });
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    await bCommitsToMain(r, "b.txt");

    expect((await merge(h, thread.id)).merge?.status).toBe("merged");
    expect(await remoteSha(r, "refs/heads/main")).toBe(await h.repo.git.revParse("refs/heads/main"));
    expect(texts(h, thread.id, "error")).toEqual([]);
  });

  it("pushBaseAfterMerge pushes even with syncBaseWithRemote off", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { syncBaseWithRemote: false, pushBaseAfterMerge: true });
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    expect((await merge(h, thread.id)).merge?.status).toBe("merged");
    expect(await remoteSha(r, "refs/heads/main")).toBe(await h.repo.git.revParse("refs/heads/main"));
  });

  it("an unreachable origin merges on the local base and says the base was not synced", async () => {
    const h = await harness(cleanups);
    await withOrigin(h);
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    await h.repo.git.run(["remote", "set-url", "origin", "/nonexistent/origin.git"]);

    const after = await merge(h, thread.id);
    expect(after.merge?.status).toBe("merged");
    expect((await h.repo.git.show("main", "feature.txt")).content).toBe("feature.txt\n");
    const infos = texts(h, thread.id, "info");
    expect(infos.some((t) => /^Base not synced: could not check main against origin \(.+\); merging into the local main$/.test(t))).toBe(true);
    expect(infos.at(-1)).toMatch(/^Merged tide\/feature into main/);
    expect(texts(h, thread.id, "error")).toEqual([]);
  });

  it("refuses to merge into a base that diverged from origin", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    await bCommitsToMain(r, "b.txt");
    await h.repo.write("local.txt", "a\n");
    const localMain = await h.repo.commit("a on main");

    const after = await merge(h, thread.id);
    expect(after.merge).toMatchObject({ status: "error" });
    expect(after.merge?.error).toMatch(/^main has diverged from origin\/main/);
    expect(after.mergedAt).toBeUndefined();
    expect(await h.repo.git.revParse("refs/heads/main")).toBe(localMain);
  });

  it("a rejected base push keeps the merge and says main was not pushed", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { pushBaseAfterMerge: true });
    const hook = join(r.origin, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nwhile read old new ref; do [ \"$ref\" = refs/heads/main ] && exit 1; done\nexit 0\n", "utf8");
    await chmod(hook, 0o755);
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");

    const after = await merge(h, thread.id);
    expect(after.merge?.status).toBe("merged");
    expect(after.mergedAt).toBeDefined();
    expect(await remoteSha(r, "refs/heads/main")).not.toBe(await h.repo.git.revParse("refs/heads/main"));
    const errors = texts(h, thread.id, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^main merged locally but not pushed: .*remote rejected/);
  });

  it("with syncBaseWithRemote off nothing is fetched or pushed", async () => {
    const h = await harness(cleanups);
    const r = await withOrigin(h);
    setGit(h, { syncBaseWithRemote: false });
    const originMain = await remoteSha(r, "refs/heads/main");
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    expect((await merge(h, thread.id)).merge?.status).toBe("merged");
    expect(await remoteSha(r, "refs/heads/main")).toBe(originMain);
  });
});

describe("C5 — generated commit and PR text", { timeout: 20_000 }, () => {
  /** The fake driver answers one-shot prompts with `text` (the test's stand-in for textModel). */
  async function answering(h: Harness, text: string): Promise<CompletionRequest[]> {
    const requests: CompletionRequest[] = [];
    const instance = (await h.app.registry.get("claude")) as ProviderInstance;
    instance.complete = async (request) => {
      requests.push(request);
      return { text, elapsedMs: 1 };
    };
    h.app.settings.set({ textModel: { provider: "claude" } });
    return requests;
  }

  it("the squash commit subject and body come from textModel", async () => {
    const h = await harness(cleanups);
    const requests = await answering(h, "Add the feature flag\n\nLets ops switch it off.");
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    // the per-turn checkpoints asked for nothing
    expect(requests).toHaveLength(0);
    await merge(h, thread.id);
    expect((await h.repo.git.run(["log", "-1", "--format=%B", "main"])).trim()).toBe("Add the feature flag\n\nLets ops switch it off.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toContain("feature.txt");
    expect(requests[0]?.timeoutMs).toBe(5_000);
  });

  it("generateMessages off keeps the thread title", async () => {
    const h = await harness(cleanups);
    const requests = await answering(h, "Should not be used");
    setGit(h, { generateMessages: false });
    const thread = await newThread(h, { useWorktree: true, title: "Feature" });
    await uncommittedTurn(h, thread.id, "feature.txt");
    await merge(h, thread.id);
    expect((await h.repo.git.run(["log", "-1", "--format=%s", "main"])).trim()).toBe("Feature");
    expect(requests).toHaveLength(0);
  });

  it("publish without a title gets a generated commit message and PR title/body", async () => {
    const h = await harness(cleanups);
    await withOrigin(h);
    await answering(h, "Ship the widget\n\nAdds widget.txt.");
    const thread = await newThread(h, { useWorktree: true, title: "Widget" });
    await uncommittedTurn(h, thread.id, "widget.txt");
    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id });
    await h.settle();
    const wt = new Git(thread.worktreePath!, { env: GIT_TEST_ENV });
    expect((await wt.run(["log", "-1", "--format=%s"])).trim()).toBe("Ship the widget");
    expect(h.gh.created[0]?.input).toMatchObject({ title: "Ship the widget", body: "Adds widget.txt." });
  });

  it("a harness that cannot answer falls back to tide: <title>", async () => {
    const h = await harness(cleanups);
    await withOrigin(h);
    const thread = await newThread(h, { useWorktree: true, title: "Widget" });
    await uncommittedTurn(h, thread.id, "widget.txt");
    await h.app.engine.dispatch({ type: "thread.publish", threadId: thread.id });
    await h.settle();
    const wt = new Git(thread.worktreePath!, { env: GIT_TEST_ENV });
    expect((await wt.run(["log", "-1", "--format=%s"])).trim()).toBe("tide: Widget");
    expect(h.gh.created[0]?.input).toMatchObject({ title: "tide: Widget" });
  });
});
