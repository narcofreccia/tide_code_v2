import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { RepoBackfill } from "./repoBackfill.ts";
import { detectRepoIdentity } from "./repoIdentity.ts";
import { createTempRepo, type TempRepo } from "./testing/tempRepo.ts";

const repos: TempRepo[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repoWithOrigin(url?: string): Promise<TempRepo> {
  const r = await createTempRepo();
  repos.push(r);
  await r.write("a.txt", "a\n");
  await r.commit("init");
  if (url !== undefined) await r.git.run(["remote", "add", "origin", url]);
  return r;
}

describe("detectRepoIdentity", () => {
  it("is undefined without origin or outside a repo", async () => {
    const r = await repoWithOrigin();
    expect(await detectRepoIdentity(r.dir, r.git)).toBeUndefined();
    const plain = await mkdtemp(join(tmpdir(), "tide-plain-"));
    dirs.push(plain);
    expect(await detectRepoIdentity(plain)).toBeUndefined();
  });

  it("reads origin, the local default branch and its sha", async () => {
    const r = await repoWithOrigin("git@GitHub.com:acme/app.git");
    const repo = await detectRepoIdentity(r.dir, r.git);
    expect(repo).toMatchObject({ remoteUrl: "github.com/acme/app", cloneUrl: "git@GitHub.com:acme/app.git", defaultBranch: "main", headSha: await r.git.revParse("HEAD") });
  });

  it("prefers origin/HEAD", async () => {
    const r = await repoWithOrigin("https://github.com/acme/app");
    const sha = (await r.git.revParse("HEAD")) ?? "";
    await r.git.run(["update-ref", "refs/remotes/origin/develop", sha]);
    await r.git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    const repo = await detectRepoIdentity(r.dir, r.git);
    expect(repo?.defaultBranch).toBe("develop");
    expect(repo?.headSha).toBeUndefined();
  });
});

describe("RepoBackfill", () => {
  it("fills projects missing a repo, on start and on create, and is idempotent", async () => {
    const withRemote = await repoWithOrigin("https://github.com/acme/one.git");
    const later = await repoWithOrigin("https://github.com/acme/two.git");
    const bare = await repoWithOrigin();
    const store = await openEventStore(":memory:");
    const engine = new Engine({ store });
    const first = (await engine.dispatch({ type: "project.create", title: "one", rootPath: withRemote.dir })).events[0]?.event;
    const none = (await engine.dispatch({ type: "project.create", title: "none", rootPath: bare.dir })).events[0]?.event;
    if (first?.type !== "project.created" || none?.type !== "project.created") throw new Error("create");

    const backfill = new RepoBackfill({ engine, log: () => undefined });
    backfill.start();
    await backfill.drain();
    expect(engine.getModel().projects[first.project.id]?.repo?.remoteUrl).toBe("github.com/acme/one");
    expect(engine.getModel().projects[none.project.id]?.repo).toBeUndefined();

    const created = (await engine.dispatch({ type: "project.create", title: "two", rootPath: later.dir })).events[0]?.event;
    if (created?.type !== "project.created") throw new Error("create");
    await backfill.drain();
    expect(engine.getModel().projects[created.project.id]?.repo?.remoteUrl).toBe("github.com/acme/two");

    const seq = store.lastSeq();
    const again = new RepoBackfill({ engine, log: () => undefined });
    again.start();
    await again.drain();
    expect(store.lastSeq()).toBe(seq);
    backfill.stop();
    again.stop();
  });

  it("never throws for a vanished root", async () => {
    const store = await openEventStore(":memory:");
    const engine = new Engine({ store });
    await engine.dispatch({ type: "project.create", title: "gone", rootPath: "/definitely/not/here" });
    const backfill = new RepoBackfill({ engine, log: () => undefined });
    backfill.start();
    await expect(backfill.drain()).resolves.toBeUndefined();
    backfill.stop();
  });
});
