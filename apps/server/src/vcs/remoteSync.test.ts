import { afterEach, describe, expect, it } from "vitest";
import { baseAheadBehind, fastForwardBase, fetchBase, hasOrigin, pushBase, pushThreadBranch, syncBase } from "./remoteSync.ts";
import { createRemotePair, type RemotePair } from "./testing/remoteRepos.ts";
import { createTempRepo } from "./testing/tempRepo.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function pair(): Promise<RemotePair> {
  const p = await createRemotePair();
  cleanups.push(() => p.cleanup());
  return p;
}

/** B lands a commit on origin/main behind A's back. */
async function bMovesMain(p: RemotePair, file = "b.txt"): Promise<string> {
  await p.b.write(file, "from b\n");
  const sha = await p.b.commit(`b: ${file}`);
  await p.b.git.run(["push", "-q", "origin", "main"]);
  return sha;
}

describe("remoteSync", { timeout: 20_000 }, () => {
  it("knows whether origin exists", async () => {
    const p = await pair();
    expect(await hasOrigin(p.a.git)).toBe(true);
    const plain = await createTempRepo();
    cleanups.push(() => plain.cleanup());
    expect(await hasOrigin(plain.git)).toBe(false);
  });

  it("pushes a thread branch and refuses to force over a moved one", async () => {
    const p = await pair();
    await p.a.git.run(["checkout", "-q", "-b", "tide/x"]);
    await p.a.write("x.txt", "1\n");
    const sha = await p.a.commit("x");
    expect(await pushThreadBranch(p.a.git, "tide/x")).toEqual({ ok: true, sha, remoteBranch: "tide/x" });
    expect((await p.b.git.run(["ls-remote", "origin", "refs/heads/tide/x"])).split("\t")[0]).toBe(sha);

    // B pushes onto the same branch; A's diverging commit is rejected, not forced
    await p.b.git.run(["fetch", "-q", "origin", "tide/x:tide/x"]);
    await p.b.git.run(["checkout", "-q", "tide/x"]);
    await p.b.write("x.txt", "b\n");
    await p.b.commit("b on x");
    await p.b.git.run(["push", "-q", "origin", "tide/x"]);
    await p.a.write("x.txt", "a\n");
    await p.a.commit("a on x");
    const again = await pushThreadBranch(p.a.git, "tide/x");
    expect(again).toEqual({ ok: false, error: "origin/tide/x has commits this machine does not have; not force-pushing" });
  });

  it("fast-forwards a clean, checked-out base that is behind origin", async () => {
    const p = await pair();
    const remote = await bMovesMain(p);
    const synced = await syncBase(p.a.git, "main");
    expect(synced).toEqual({ ok: true, note: "main fast-forwarded to origin (1 new commit)" });
    expect(await p.a.git.revParse("HEAD")).toBe(remote);
    expect(await p.a.git.status()).toEqual({ dirty: 0 });
  });

  it("moves only the ref when nothing has the base checked out", async () => {
    const p = await pair();
    const remote = await bMovesMain(p);
    await p.a.git.run(["checkout", "-q", "-b", "elsewhere"]);
    expect((await syncBase(p.a.git, "main")).ok).toBe(true);
    expect(await p.a.git.revParse("refs/heads/main")).toBe(remote);
  });

  it("refuses a dirty base checkout and a diverged base", async () => {
    const p = await pair();
    await bMovesMain(p);
    await p.a.write("README.md", "local edit\n");
    const dirty = await syncBase(p.a.git, "main");
    expect(dirty.ok).toBe(false);
    expect(dirty.note).toMatch(/^main is 1 commit behind origin and .+ has uncommitted changes/);

    await p.a.commit("a on main");
    const diverged = await syncBase(p.a.git, "main");
    expect(diverged).toEqual({ ok: false, note: "main has diverged from origin/main (1 local, 1 remote commits); reconcile them and retry" });
  });

  it("is a no-op when up to date or ahead, and when origin lacks the base", async () => {
    const p = await pair();
    expect(await syncBase(p.a.git, "main")).toEqual({ ok: true });
    await p.a.write("a.txt", "a\n");
    await p.a.commit("ahead");
    expect(await syncBase(p.a.git, "main")).toEqual({ ok: true });
    expect(await fetchBase(p.a.git, "nope")).toEqual({ ok: true, found: false });
    expect(await baseAheadBehind(p.a.git, "main")).toEqual({ ahead: 1, behind: 0 });
  });

  it("refuses to merge onto an unreachable origin", async () => {
    const p = await pair();
    await p.a.git.run(["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    const r = await syncBase(p.a.git, "main");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/^could not fetch main from origin/);
  });

  it("pushes the base and explains a rejection", async () => {
    const p = await pair();
    await p.a.write("a.txt", "a\n");
    const sha = await p.a.commit("a");
    expect(await pushBase(p.a.git, "main")).toEqual({ ok: true });
    expect((await p.b.git.run(["ls-remote", "origin", "refs/heads/main"])).split("\t")[0]).toBe(sha);

    await p.b.git.run(["pull", "-q", "--ff-only"]);
    await bMovesMain(p, "c.txt");
    await p.a.write("a2.txt", "a\n");
    await p.a.commit("a2");
    expect(await pushBase(p.a.git, "main")).toEqual({ ok: false, error: "main moved on origin, pull first" });
  });

  it("fastForwardBase reports what it did", async () => {
    const p = await pair();
    const remote = await bMovesMain(p);
    await fetchBase(p.a.git, "main");
    expect(await fastForwardBase(p.a.git, "main")).toEqual({ outcome: "fast-forwarded", sha: remote, commits: 1 });
    expect(await fastForwardBase(p.a.git, "main")).toEqual({ outcome: "up-to-date", sha: remote });
    expect(await fastForwardBase(p.a.git, "missing")).toEqual({ outcome: "missing" });
  });
});
