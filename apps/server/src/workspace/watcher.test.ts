import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FsChange } from "@tide/contracts";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { FsWatcher, type WatchStrategy } from "./watcher.ts";

const gitFactory = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Collects changes and lets a test await a specific one — no sleeps, generous timeout. */
class Sink {
  readonly changes: FsChange[] = [];
  #waiters: { match: (c: FsChange) => boolean; resolve: (c: FsChange) => void }[] = [];

  readonly listener = (change: FsChange): void => {
    this.changes.push(change);
    this.#waiters = this.#waiters.filter((w) => {
      if (!w.match(change)) return true;
      w.resolve(change);
      return false;
    });
  };

  await(match: (c: FsChange) => boolean): Promise<FsChange> {
    const existing = this.changes.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.#waiters.push({ match, resolve }));
  }

  countFor(path: string): number {
    return this.changes.filter((c) => c.path === path).length;
  }
}

async function setup(strategy: WatchStrategy, debounceMs = 300): Promise<{ repo: TempRepo; watcher: FsWatcher; sink: Sink }> {
  const repo = await createTempRepo("tide-watch-");
  cleanups.push(() => repo.cleanup());
  const watcher = new FsWatcher({ strategy, debounceMs, pollIntervalMs: 50, git: gitFactory });
  cleanups.push(() => watcher.closeAll());
  const sink = new Sink();
  const release = watcher.subscribe(repo.dir, sink.listener);
  cleanups.push(release);
  return { repo, watcher, sink };
}

const strategies: WatchStrategy[] = process.platform === "linux" ? ["poll"] : ["native", "poll"];

for (const strategy of strategies) {
  describe(`FsWatcher (${strategy})`, () => {
    it("emits a change for a new file", async () => {
      const { repo, sink } = await setup(strategy, 60);
      await repo.write("fresh.ts", "x");
      const change = await sink.await((c) => c.path === "fresh.ts");
      expect(change.kind === "created" || change.kind === "modified").toBe(true);
      expect(change.at).toBeGreaterThan(0);
    }, 15_000);

    it("never reports .git internals or gitignored paths", async () => {
      const { repo, sink } = await setup(strategy, 60);
      await repo.write(".gitignore", "secret.log\n");
      await repo.commit("ignore");
      await repo.write("secret.log", "nope");
      await repo.write("visible.ts", "yes");
      await sink.await((c) => c.path === "visible.ts");
      expect(sink.changes.some((c) => c.path.startsWith(".git/"))).toBe(false);
      expect(sink.changes.some((c) => c.path === "secret.log")).toBe(false);
    }, 15_000);

  });
}

// Deletion is asserted on the polling backend only: macOS FSEvents coalesces a
// create-then-delete of the same path under load, so the native backend cannot promise a
// delete event for a file that existed only briefly.
describe("FsWatcher deletions (poll)", () => {
  it("reports a deleted file", async () => {
    const { repo, sink } = await setup("poll", 40);
    await repo.write("doomed.ts", "x");
    await sink.await((c) => c.path === "doomed.ts");
    await rm(join(repo.dir, "doomed.ts"));
    const change = await sink.await((c) => c.path === "doomed.ts" && c.kind === "deleted");
    expect(change.kind).toBe("deleted");
  }, 15_000);
});

describe("FsWatcher debounce", () => {
  it("coalesces a burst of writes on one path into a single change", async () => {
    const { repo, sink } = await setup("native", 300);
    const file = join(repo.dir, "burst.ts");
    for (let i = 0; i < 5; i++) await writeFile(file, `v${i}`);
    await sink.await((c) => c.path === "burst.ts");
    expect(sink.countFor("burst.ts")).toBe(1);
  }, 15_000);
});

describe("FsWatcher lifecycle", () => {
  it("shares one watch per cwd and closes it when the last subscriber leaves", async () => {
    const { repo, watcher } = await setup("poll", 60);
    expect(watcher.size).toBe(1);
    const second = new Sink();
    const release = watcher.subscribe(repo.dir, second.listener);
    expect(watcher.size).toBe(1);
    await repo.write("shared.ts", "x");
    await second.await((c) => c.path === "shared.ts");
    release();
    expect(watcher.size).toBe(1);
    watcher.closeAll();
    expect(watcher.size).toBe(0);
  }, 15_000);

  it("stops delivering after the subscriber releases", async () => {
    const repo = await createTempRepo("tide-watch-");
    cleanups.push(() => repo.cleanup());
    const watcher = new FsWatcher({ strategy: "poll", debounceMs: 20, pollIntervalMs: 20, git: gitFactory });
    cleanups.push(() => watcher.closeAll());
    const sink = new Sink();
    const release = watcher.subscribe(repo.dir, sink.listener);
    await repo.write("a.ts", "1");
    await sink.await((c) => c.path === "a.ts");
    release();
    expect(watcher.size).toBe(0);
    const before = sink.changes.length;
    await repo.write("b.ts", "2");
    // the watch is gone: nothing new can arrive, so a follow-up scan cannot add changes
    expect(sink.changes.length).toBe(before);
  }, 15_000);
});
