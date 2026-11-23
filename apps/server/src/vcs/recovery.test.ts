import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MergeStrategy, ReadModel, Thread } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import { openEventStore, type EventStore } from "../orchestration/store.ts";
import { createFakeDriver, effect, emit, type FakeDriverControl } from "../provider/testing/fakeDriver.ts";
import { MAIN_CHECKOUT_WARNING, MERGE_RESTART_ERROR } from "./recovery.ts";
import { createTempRepo, type TempRepo } from "./testing/tempRepo.ts";
import { activitiesOf, baseConfig, FakeGh } from "./testing/vcsHarness.ts";
import { WorktreeManager } from "./worktrees.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * One repo, one TIDE_HOME and one store shared by successive app instances: `boot()` is a server
 * start, `crash()` stops the vcs reactor so the intents dispatched after it are never answered
 * (what a `kill -9` between intent and report leaves in the log).
 */
interface World {
  repo: TempRepo;
  tideHome: string;
  store: EventStore;
  app: App;
  control: FakeDriverControl;
  projectId: string;
  /** `script` runs before the app boots, so a turn recovery resumes finds its script */
  boot(script?: (control: FakeDriverControl) => void, options?: { killed?: boolean }): Promise<App>;
  crash(): void;
  settle(): Promise<void>;
  model(): ReadModel;
}

async function world(): Promise<World> {
  const repo = await createTempRepo("tide-recovery-");
  const tideHome = await mkdtemp(join(tmpdir(), "tide-recovery-home-"));
  const store = await openEventStore(":memory:");
  const apps: App[] = [];
  cleanups.push(
    async () => {
      for (const a of apps.reverse()) await a.close().catch(() => undefined);
      store.close();
    },
    () => repo.cleanup(),
    () => rm(tideHome, { recursive: true, force: true }),
  );
  const w = {} as World;
  w.repo = repo;
  w.tideHome = tideHome;
  w.store = store;
  w.boot = async (script, options) => {
    // killed: the previous instance is abandoned without its graceful shutdown (closed at cleanup)
    const previous = apps.at(-1);
    if (previous !== undefined && options?.killed !== true) await previous.close();
    const { driver, control } = createFakeDriver("claude");
    script?.(control);
    const app = await createApp({
      config: baseConfig(tideHome),
      store,
      keepStoreOpen: true,
      shutdownTimeoutMs: 0,
      listen: false,
      log: () => undefined,
      gh: new FakeGh(),
      registerDrivers: (r) => r.register(driver),
    });
    apps.push(app);
    w.app = app;
    w.control = control;
    return app;
  };
  w.crash = () => w.app.vcs.stop();
  w.settle = async () => {
    for (let i = 0; i < 2; i++) {
      await w.app.reactor.drain();
      await w.app.vcs.drain();
      await w.app.engine.drain();
    }
  };
  w.model = () => w.app.engine.getModel();
  await w.boot();
  const created = (await w.app.engine.dispatch({ type: "project.create", title: "Repo", rootPath: repo.dir })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project.created");
  w.projectId = created.project.id;
  return w;
}

async function createThread(w: World, title: string, useWorktree = true): Promise<string> {
  const created = (await w.app.engine.dispatch({ type: "thread.create", projectId: w.projectId, provider: "claude", title, useWorktree })).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("expected thread.created");
  await w.settle();
  return created.thread.id;
}

async function runTurn(w: World, threadId: string, file?: string): Promise<void> {
  w.control.script(
    effect(async (options) => {
      if (file !== undefined) await writeFile(join(options.cwd, file), `${file}\n`, "utf8");
    }),
    emit({ type: "settled", status: "completed" }),
  );
  await w.app.engine.dispatch({ type: "turn.request", threadId, text: "work" });
  await w.settle();
}

/** A worktree thread with one turn of work, then a merge the dead reactor never answers. */
async function crashedMerge(w: World, strategy: MergeStrategy): Promise<Thread> {
  const id = await createThread(w, "Add feature");
  await runTurn(w, id, "feature.txt");
  w.crash();
  await w.app.engine.dispatch({ type: "thread.merge", threadId: id, strategy });
  const thread = w.model().threads[id] as Thread;
  expect(thread.merge?.status).toBe("merging");
  return thread;
}

const rows = (w: World, threadId: string) => activitiesOf(w.model(), threadId).filter((a) => a.kind === "info" || a.kind === "error");
const textOf = (a: { kind: string; text?: string }) => ("text" in a ? (a.text ?? "") : "");

describe("vcs boot recovery — merges", () => {
  it("a merge cut short is reported failed after the restart, and merging again succeeds", async () => {
    const w = await world();
    const thread = await crashedMerge(w, "squash");
    await w.boot();
    await w.settle();
    const after = w.model().threads[thread.id];
    expect(after?.merge?.status).toBe("error");
    expect(after?.merge?.error).toContain(MERGE_RESTART_ERROR);
    expect(rows(w, thread.id).some((a) => a.kind === "error" && textOf(a).includes("interrupted by a server restart"))).toBe(true);

    await w.app.engine.dispatch({ type: "thread.merge", threadId: thread.id, strategy: "squash" });
    await w.settle();
    expect(w.model().threads[thread.id]?.merge?.status).toBe("merged");
    expect(await readFile(join(w.repo.dir, "feature.txt"), "utf8")).toBe("feature.txt\n");
  });

  it("removes the scratch merge worktree a dead merge left behind", async () => {
    const w = await world();
    const thread = await crashedMerge(w, "merge");
    // what the dead process left: the detached scratch checkout of the base, mid-merge
    const tmp = join(w.app.worktrees.root, `.merge-${thread.id}`);
    await w.repo.git.run(["worktree", "add", "--detach", tmp, "main"]);
    await w.repo.git.at(tmp).tryRun(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-commit", "--no-ff", thread.branch as string]);
    await w.boot();
    await w.settle();
    expect(existsSync(tmp)).toBe(false);
    expect((await w.repo.git.worktreeList()).some((e) => e.path.includes(".merge-"))).toBe(false);
    expect(w.model().threads[thread.id]?.merge?.status).toBe("error");
  });

  it("a merge that landed before the report was lost settles as merged", async () => {
    const w = await world();
    const thread = await crashedMerge(w, "merge");
    // the dead process got as far as moving main (commit pending work, merge --no-ff into main)
    const wt = w.repo.git.at(thread.worktreePath as string);
    await wt.run(["add", "-A"]);
    await wt.run(["commit", "-q", "-m", "work"]);
    await w.repo.git.run(["merge", "--no-ff", "--no-edit", thread.branch as string]);
    const main = await w.repo.git.revParse("refs/heads/main");
    await w.boot();
    await w.settle();
    const after = w.model().threads[thread.id];
    expect(after?.merge).toMatchObject({ status: "merged", sha: main });
    expect(after?.mergedAt).toBeDefined();
  });
});

describe("vcs boot recovery — merge detection limits", () => {
  async function landedElsewhere(strategy: MergeStrategy): Promise<{ w: World; thread: Thread }> {
    const w = await world();
    const thread = await crashedMerge(w, strategy);
    const wt = w.repo.git.at(thread.worktreePath as string);
    await wt.run(["add", "-A"]);
    await wt.run(["commit", "-q", "-m", "work"]);
    // main moved on, then got the branch's commit replayed on top (what a rebase merge-back does)
    await w.repo.write("other.txt", "other\n");
    await w.repo.commit("other");
    await w.repo.git.run(["cherry-pick", thread.branch as string]);
    return { w, thread };
  }

  it("a rebase that landed is recognised by patch identity", async () => {
    const { w, thread } = await landedElsewhere("rebase");
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge?.status).toBe("merged");
  });

  it("a squash cannot be recognised: it is reported interrupted, with a hint to look first", async () => {
    const { w, thread } = await landedElsewhere("squash");
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge).toMatchObject({ status: "error" });
    expect(w.model().threads[thread.id]?.merge?.error).toContain("squash");
  });
});

describe("vcs boot recovery — worktrees", () => {
  it("adopts an orphan worktree created before the attach was recorded", async () => {
    const w = await world();
    w.crash();
    const id = await createThread(w, "Orphan");
    const model = w.model();
    // the dead reactor's `git worktree add` ran; its worktree.attach never did
    const orphan = await new WorktreeManager({ tideHome: w.tideHome }).create(model.projects[w.projectId]!, model.threads[id]!);
    await w.boot();
    await w.settle();
    expect(w.model().threads[id]).toMatchObject({ worktreePath: orphan.worktreePath, branch: orphan.branch, baseBranch: "main" });
  });

  it("creates the worktree a thread wanted when nothing was created, and its first turn runs there", async () => {
    const w = await world();
    w.crash();
    const id = await createThread(w, "Never made");
    expect(w.model().threads[id]?.worktreePath).toBeUndefined();
    await w.boot();
    await w.settle();
    const thread = w.model().threads[id];
    expect(thread?.worktreePath).toBeDefined();
    expect(existsSync(thread!.worktreePath!)).toBe(true);
    await runTurn(w, id, "x.txt");
    expect(existsSync(join(thread!.worktreePath!, "x.txt"))).toBe(true);
    expect(existsSync(join(w.repo.dir, "x.txt"))).toBe(false);
  });

  it("an unsent first turn resumed after the restart runs in the worktree recovery created", async () => {
    const w = await world();
    w.crash();
    w.app.reactor.stop();
    const id = await createThread(w, "Queued first");
    await w.app.engine.dispatch({ type: "turn.request", threadId: id, text: "work" });
    await w.app.engine.drain();
    expect(Object.values(w.model().turns).find((t) => t.threadId === id)).toMatchObject({ status: "requested" });
    // the next boot's driver writes the file in whatever cwd the resumed turn got
    await w.boot((c) =>
      c.script(
        effect(async (options) => {
          await writeFile(join(options.cwd, "first.txt"), "x\n", "utf8");
        }),
        emit({ type: "settled", status: "completed" }),
      ),
      { killed: true },
    );
    await w.settle();
    const thread = w.model().threads[id];
    expect(thread?.worktreePath).toBeDefined();
    expect(existsSync(join(thread!.worktreePath!, "first.txt"))).toBe(true);
    expect(existsSync(join(w.repo.dir, "first.txt"))).toBe(false);
  });

  it("a thread that already ran in the main checkout gets one warning, across two boots", async () => {
    const w = await world();
    w.crash();
    const id = await createThread(w, "Ran in root");
    await runTurn(w, id);
    await w.boot();
    await w.settle();
    await w.boot();
    await w.settle();
    const warnings = rows(w, id).filter((a) => textOf(a) === MAIN_CHECKOUT_WARNING);
    expect(warnings).toHaveLength(1);
    expect(w.model().threads[id]?.worktreePath).toBeUndefined();
  });

  it("a thread created without a worktree is left alone", async () => {
    const w = await world();
    w.crash();
    const id = await createThread(w, "Plain", false);
    await runTurn(w, id);
    await w.boot();
    await w.settle();
    expect(w.model().threads[id]?.worktreePath).toBeUndefined();
    expect(rows(w, id)).toHaveLength(0);
  });

  it("prunes stale registrations and removes only empty unreferenced worktree dirs", async () => {
    const w = await world();
    const project = w.model().projects[w.projectId]!;
    const dir = w.app.worktrees.projectDir(project);
    // a registered worktree whose directory vanished
    const gone = join(dir, "gone0000");
    await w.repo.git.run(["worktree", "add", "-b", "tide/gone", gone, "main"]);
    await rm(gone, { recursive: true, force: true });
    // an empty stray dir, and one holding files nobody can vouch for
    const empty = join(dir, "empty000");
    const busy = join(dir, "busy0000");
    await mkdir(empty, { recursive: true });
    await mkdir(busy, { recursive: true });
    await writeFile(join(busy, "notes.txt"), "mine\n", "utf8");
    await w.boot();
    await w.settle();
    expect((await w.repo.git.worktreeList()).some((e) => e.path.endsWith("gone0000"))).toBe(false);
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(busy)).toBe(true);
  });

  it("a project whose repository is gone does not stop recovery of another", async () => {
    const w = await world();
    w.crash();
    const id = await createThread(w, "Healthy");
    // a second project on a path that is no git repository, with a merge stuck in flight
    const broken = (await w.app.engine.dispatch({ type: "project.create", title: "Gone", rootPath: join(w.tideHome, "no-such-repo") })).events[0]?.event;
    if (broken?.type !== "project.created") throw new Error("expected project.created");
    const t = (await w.app.engine.dispatch({ type: "thread.create", projectId: broken.project.id, provider: "claude", title: "Stuck", useWorktree: false })).events[0]?.event;
    if (t?.type !== "thread.created") throw new Error("expected thread.created");
    await w.app.engine.dispatch({ type: "worktree.attach", threadId: t.thread.id, worktreePath: join(w.tideHome, "nowhere"), branch: "tide/stuck", baseBranch: "main" });
    await w.app.engine.dispatch({ type: "thread.merge", threadId: t.thread.id, strategy: "merge" });
    await w.boot();
    await w.settle();
    expect(w.model().threads[t.thread.id]?.merge?.status).toBe("error");
    expect(w.model().threads[id]?.worktreePath).toBeDefined();
  });
});

describe("vcs boot recovery — lost publish", () => {
  it("a publish the dead reactor never finished gets an info row after the restart", async () => {
    const w = await world();
    const id = await createThread(w, "Publish me");
    await runTurn(w, id, "p.txt");
    // the journal entry is written when the reactor takes the intent; kill it before it runs
    let release: () => void = () => undefined;
    const blocked = w.app.vcs.exclusive(id, () => new Promise<void>((resolve) => (release = resolve)));
    await w.app.engine.dispatch({ type: "thread.publish", threadId: id, commitOnly: true });
    await w.app.engine.drain();
    w.crash();
    const journal = w.store.getMeta("vcs.inflight") ?? "";
    expect(journal).toContain(id);
    // a killed process never finishes the task; here it does, so the journal is put back as the kill left it
    release();
    await blocked;
    await w.app.vcs.drain();
    w.store.setMeta("vcs.inflight", journal);
    await w.boot();
    await w.settle();
    expect(rows(w, id).some((a) => textOf(a).startsWith("A publish was interrupted"))).toBe(true);
    expect(w.store.getMeta("vcs.inflight")).toBe("{}");
  });
});

describe("vcs boot recovery — R19 L3 squash that landed before the crash", () => {
  /** A crashed squash with the thread's work committed on its branch (MergeBack's commitPending ran) and the journal entry #mergeBack writes. */
  async function journaledSquash(): Promise<{ w: World; thread: Thread; recorded: string }> {
    const w = await world();
    const thread = await crashedMerge(w, "squash");
    const wt = w.repo.git.at(thread.worktreePath as string);
    await wt.run(["add", "-A"]);
    await wt.run(["commit", "-q", "-m", "tide: Add feature"]);
    const recorded = (await w.repo.git.revParse("refs/heads/main")) as string;
    w.store.setMeta("vcs.inflight", JSON.stringify({ "9999": { threadId: thread.id, kind: "merge", baseSha: recorded } }));
    return { w, thread, recorded };
  }
  /** What MergeBack's squash does, run in the main checkout (clean, on main): the base moves to the squash commit. */
  async function squashOntoMain(w: World, thread: Thread): Promise<string> {
    await w.repo.git.run(["merge", "--squash", thread.branch as string]);
    await w.repo.git.run(["commit", "-q", "-m", "Add feature"]);
    return (await w.repo.git.revParse("refs/heads/main")) as string;
  }

  it("a crash before the squash commit is reported interrupted", async () => {
    const { w, thread } = await journaledSquash();
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge).toMatchObject({ status: "error", error: MERGE_RESTART_ERROR });
    expect(w.store.getMeta("vcs.inflight")).toBe("{}");
  });

  it("a crash after the squash commit but before the report settles as merged on that commit", async () => {
    const { w, thread, recorded } = await journaledSquash();
    const squash = await squashOntoMain(w, thread);
    expect(squash).not.toBe(recorded);
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge).toMatchObject({ status: "merged", sha: squash });
    expect(rows(w, thread.id).some((a) => textOf(a).includes("the squash of"))).toBe(true);
  });

  it("is still recognised when someone committed on top of the squash afterwards", async () => {
    const { w, thread } = await journaledSquash();
    const squash = await squashOntoMain(w, thread);
    await w.repo.write("later.txt", "later\n");
    await w.repo.commit("later");
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge).toMatchObject({ status: "merged", sha: squash });
  });

  it("a base moved by someone else's unrelated commit is reported interrupted", async () => {
    const { w, thread } = await journaledSquash();
    await w.repo.write("other.txt", "other\n");
    await w.repo.commit("other");
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge).toMatchObject({ status: "error", error: MERGE_RESTART_ERROR });
  });

  it("the commit the merge returned (journaled before branch deletion) settles it even when the branch is gone", async () => {
    const { w, thread, recorded } = await journaledSquash();
    const squash = await squashOntoMain(w, thread);
    w.store.setMeta("vcs.inflight", JSON.stringify({ "9999": { threadId: thread.id, kind: "merge", baseSha: recorded, landed: squash } }));
    await w.repo.git.run(["worktree", "remove", "--force", thread.worktreePath as string]);
    await w.repo.git.run(["branch", "-D", thread.branch as string]);
    await w.boot();
    await w.settle();
    expect(w.model().threads[thread.id]?.merge).toMatchObject({ status: "merged", sha: squash });
  });

  it("a live merge leaves no journal entry behind", async () => {
    const w = await world();
    const id = await createThread(w, "Live");
    await runTurn(w, id, "live.txt");
    await w.app.engine.dispatch({ type: "thread.merge", threadId: id, strategy: "squash" });
    await w.settle();
    expect(w.model().threads[id]?.merge?.status).toBe("merged");
    expect(w.store.getMeta("vcs.inflight")).toBe("{}");
  });
});

describe("vcs boot recovery — R19 L2 orphaned checkpoint refs", () => {
  const refsOf = (w: World, id: string) => w.repo.git.listRefs(`refs/tide/checkpoints/${id}/`);

  it("removes the refs of a thread deleted while the server died; live, archived and unknown threads keep theirs", async () => {
    const w = await world();
    const deleted = await createThread(w, "Deleted");
    await runTurn(w, deleted, "d.txt");
    const archived = await createThread(w, "Archived");
    await runTurn(w, archived, "a.txt");
    const live = await createThread(w, "Live");
    await runTurn(w, live, "l.txt");
    await w.app.engine.dispatch({ type: "thread.archive", threadId: archived, keepWorktree: true });
    await w.settle();
    // a thread this server's log never had (another TIDE_HOME on the same repo)
    const head = (await w.repo.git.revParse("HEAD")) as string;
    await w.repo.git.updateRef("refs/tide/checkpoints/foreign-thread/turn-1/before", head);
    expect((await refsOf(w, deleted)).length).toBe(2);

    w.crash();
    await w.app.engine.dispatch({ type: "thread.delete", threadId: deleted });
    await w.app.engine.drain();
    expect(w.model().threads[deleted]).toBeUndefined();
    expect((await refsOf(w, deleted)).length).toBe(2);

    await w.boot();
    await w.settle();
    expect(await refsOf(w, deleted)).toEqual([]);
    expect((await refsOf(w, archived)).length).toBe(2);
    expect((await refsOf(w, live)).length).toBe(2);
    expect((await refsOf(w, "foreign-thread")).length).toBe(1);
  });
});
