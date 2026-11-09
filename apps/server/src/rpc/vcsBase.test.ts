import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { CheckpointService } from "../vcs/checkpoints.ts";
import { Git } from "../vcs/git.ts";
import { createRemotePair, type RemotePair } from "../vcs/testing/remoteRepos.ts";
import { createTempRepo, GIT_TEST_ENV } from "../vcs/testing/tempRepo.ts";
import { RpcRouter } from "./router.ts";
import { registerVcsHandlers } from "./vcs.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface BaseStatus {
  branch: string;
  ahead?: number;
  behind?: number;
  dirty: boolean;
  hasRemote: boolean;
  fetchedAt?: number;
}

async function rig(rootPath: string, clock: { t: number }) {
  const store = await openEventStore(":memory:");
  cleanups.push(async () => store.close());
  const engine = new Engine({ store });
  const git = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });
  const router = new RpcRouter();
  registerVcsHandlers(router, { engine, checkpoints: new CheckpointService({ git }), git, now: () => clock.t });
  const created = (await engine.dispatch({ type: "project.create", title: "Repo", rootPath })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project.created");
  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error(`no frame for ${method}`);
  };
  return { call, projectId: created.project.id };
}

async function pair(): Promise<RemotePair> {
  const p = await createRemotePair();
  cleanups.push(() => p.cleanup());
  return p;
}

async function bPushesMain(p: RemotePair, file: string): Promise<string> {
  await p.b.write(file, "b\n");
  const sha = await p.b.commit(file);
  await p.b.git.run(["push", "-q", "origin", "main"]);
  return sha;
}

describe("rpc vcs.baseStatus / vcs.pullBase", { timeout: 20_000 }, () => {
  it("reports ahead/behind against origin, fetching at most once a minute unless refreshed", async () => {
    const p = await pair();
    const clock = { t: 1_000_000 };
    const { call, projectId } = await rig(p.a.dir, clock);

    expect((await call<BaseStatus>("vcs.baseStatus", { projectId })).result).toEqual({
      branch: "main", ahead: 0, behind: 0, dirty: false, hasRemote: true, fetchedAt: 1_000_000,
    });

    await bPushesMain(p, "b.txt");
    await p.a.write("dirty.txt", "x\n");
    clock.t += 5_000;
    // throttled: the fetch from a moment ago still stands
    expect((await call<BaseStatus>("vcs.baseStatus", { projectId, refresh: true })).result).toMatchObject({ behind: 0, dirty: true, fetchedAt: 1_000_000 });
    clock.t += 6_000;
    expect((await call<BaseStatus>("vcs.baseStatus", { projectId, refresh: true })).result).toMatchObject({ ahead: 0, behind: 1, fetchedAt: 1_011_000 });

    await p.a.remove("dirty.txt");
    await p.a.write("a.txt", "a\n");
    await p.a.commit("a");
    expect((await call<BaseStatus>("vcs.baseStatus", { projectId })).result).toMatchObject({ ahead: 1, behind: 1, fetchedAt: 1_011_000 });
  });

  it("a repo without origin has no counts", async () => {
    const repo = await createTempRepo();
    cleanups.push(() => repo.cleanup());
    const { call, projectId } = await rig(repo.dir, { t: 0 });
    expect((await call<BaseStatus>("vcs.baseStatus", { projectId })).result).toEqual({ branch: "main", dirty: false, hasRemote: false });
    expect((await call("vcs.pullBase", { projectId })).error?.code).toBe("conflict");
  });

  it("pullBase fast-forwards a clean base and refuses a dirty or diverged one", async () => {
    const p = await pair();
    const { call, projectId } = await rig(p.a.dir, { t: 0 });
    const first = await bPushesMain(p, "b1.txt");
    expect((await call("vcs.pullBase", { projectId })).result).toEqual({ ok: true, sha: first });
    expect(await p.a.git.revParse("HEAD")).toBe(first);
    expect((await p.a.git.status()).dirty).toBe(0);

    await bPushesMain(p, "b2.txt");
    await p.a.write("README.md", "local edit\n");
    const dirty = await call("vcs.pullBase", { projectId });
    expect(dirty.error?.code).toBe("conflict");
    expect(dirty.error?.message).toMatch(/uncommitted changes/);
    expect(await p.a.git.revParse("HEAD")).toBe(first);

    await p.a.commit("a on main");
    const diverged = await call("vcs.pullBase", { projectId });
    expect(diverged.error).toMatchObject({ code: "conflict", message: "main has diverged from origin/main (1 local, 1 remote commits)" });
  });

  it("an unreachable origin answers ok:false with the reason", async () => {
    const p = await pair();
    await p.a.git.run(["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    const { call, projectId } = await rig(p.a.dir, { t: 0 });
    const r = await call<{ ok: boolean; error?: string }>("vcs.pullBase", { projectId });
    expect(r.result?.ok).toBe(false);
    expect(r.result?.error).toMatch(/^could not fetch main from origin/);
  });
});
