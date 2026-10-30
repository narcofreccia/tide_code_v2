import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame, RpcInput, RpcOutput, UnaryMethodName } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { GhError } from "../vcs/gh.ts";
import { detailOf, FakeForge, fixedResolver, prOf } from "../vcs/testing/fakeForge.ts";
import { registerPrHandlers } from "./pr.ts";
import { RpcRouter } from "./router.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup() {
  const store = await openEventStore(":memory:");
  cleanups.push(() => store.close());
  const engine = new Engine({ store });
  const forge = new FakeForge();
  const router = new RpcRouter();
  registerPrHandlers(router, { engine, forges: fixedResolver(forge), now: () => NOW });
  const frames: RpcFrame[] = [];
  const connection = router.connection("client", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <M extends UnaryMethodName>(method: M, params: RpcInput<M>): Promise<{ result?: RpcOutput<M>; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as RpcOutput<M> };
    if (frame && "error" in frame) return { error: frame.error as { code: string; message: string } };
    throw new Error("no frame");
  };
  const project = async (title = "Repo"): Promise<string> => {
    const e = (await engine.dispatch({ type: "project.create", title, rootPath: `/repos/${title}` })).events[0]?.event;
    if (e?.type !== "project.created") throw new Error("expected project");
    return e.project.id;
  };
  const thread = async (projectId: string): Promise<string> => {
    const e = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude" })).events[0]?.event;
    if (e?.type !== "thread.created") throw new Error("expected thread");
    return e.thread.id;
  };
  return { engine, forge, call, project, thread };
}

describe("rpc pr.list", () => {
  it("merges the viewer's PRs with every thread's PR and names the owning thread", async () => {
    const { engine, forge, call, project, thread } = await setup();
    const projectId = await project();
    const [mine, theirs, old] = [await thread(projectId), await thread(projectId), await thread(projectId)];
    forge.list = [prOf(1, { author: "me" }), prOf(2, { author: "me" })];
    await engine.dispatch({ type: "pr.update", threadId: mine, pr: prOf(2) });
    await engine.dispatch({ type: "pr.update", threadId: theirs, pr: prOf(9) });
    await engine.dispatch({ type: "pr.update", threadId: old, pr: prOf(3, { state: "closed", updatedAt: NOW - 30 * DAY }) });
    forge.views.set(prOf(9).url, prOf(9, { author: "bob", state: "merged", mergedAt: 77 }));

    const { result } = await call("pr.list", {});
    expect(result!.viewer).toBe("me");
    expect(result!.items.map((i: { pr: { number: number }; threadId?: string }) => [i.pr.number, i.threadId])).toEqual([
      [2, mine],
      [1, undefined],
      [9, theirs],
    ]);
    expect(forge.callsOf("prList")).toEqual([["/repos/Repo", { state: "open", author: "@me" }]]);
    // the merge the list noticed is written back, so the thread settles without waiting for a poll
    expect(engine.getModel().threads[theirs]?.pr).toMatchObject({ state: "merged", mergedAt: 77 });

    const all = await call("pr.list", { state: "all" });
    expect(all.result!.items.map((i: { pr: { number: number } }) => i.pr.number)).toContain(3);
  });

  it("caches for a minute unless asked to refresh, and dedupes repos shared by projects", async () => {
    const { forge, call, project } = await setup();
    await project("A");
    await project("B");
    forge.list = [prOf(1)];
    expect((await call("pr.list", {})).result!.items).toHaveLength(1);
    await call("pr.list", {});
    expect(forge.callsOf("prList")).toHaveLength(2);
    await call("pr.list", { refresh: true });
    expect(forge.callsOf("prList")).toHaveLength(4);
  });

  it("says how to log in when gh is not authenticated", async () => {
    const { forge, call, project } = await setup();
    const projectId = await project();
    forge.auth = { loggedIn: false };
    const { error } = await call("pr.list", { projectId });
    expect(error?.code).toBe("conflict");
    expect(error?.message).toContain("gh auth login");
    expect((await call("pr.list", { refresh: true })).error?.code).toBe("conflict");
  });

  it("maps gh failures to internal and unknown projects to not-found", async () => {
    const { forge, call, project } = await setup();
    const projectId = await project();
    forge.prList = async () => {
      throw new GhError("gh pr list failed", "HTTP 502: bad gateway");
    };
    expect((await call("pr.list", { projectId })).error).toMatchObject({ code: "internal", message: "gh pr list failed: HTTP 502: bad gateway" });
    expect((await call("pr.list", { projectId: "nope" })).error?.code).toBe("not-found");
  });
});

describe("rpc pr.link", () => {
  it("attaches a PR by number and starts watching it", async () => {
    const { engine, forge, call, project, thread } = await setup();
    const threadId = await thread(await project());
    forge.views.set("5", prOf(5, { title: "Five" }));
    const { result } = await call("pr.link", { threadId, pr: "#5" });
    expect(result!.pr).toMatchObject({ number: 5, title: "Five" });
    expect(forge.callsOf("prView")).toEqual([["/repos/Repo", "5"]]);
    expect(engine.getModel().threads[threadId]?.pr?.number).toBe(5);
    expect(engine.getModel().threads[threadId]?.prWatch).toBeDefined();
  });

  it("attaches a PR by URL, without watching one that is already merged", async () => {
    const { engine, forge, call, project, thread } = await setup();
    const threadId = await thread(await project());
    const url = "https://github.com/other/lib/pull/12";
    forge.views.set(url, { ...prOf(12, { state: "merged", repo: "other/lib" }), url });
    expect((await call("pr.link", { threadId, pr: url })).result!.pr.url).toBe(url);
    expect(engine.getModel().threads[threadId]?.pr?.repo).toBe("other/lib");
    expect(engine.getModel().threads[threadId]?.prWatch).toBeUndefined();
  });

  it("rejects garbage and PRs the forge does not know", async () => {
    const { call, project, thread } = await setup();
    const threadId = await thread(await project());
    expect((await call("pr.link", { threadId, pr: "fix-branch" })).error?.code).toBe("invalid-params");
    expect((await call("pr.link", { threadId, pr: "404" })).error?.code).toBe("not-found");
    expect((await call("pr.link", { threadId: "nope", pr: "1" })).error?.code).toBe("not-found");
  });
});

describe("rpc pr.* actions", () => {
  it("diffs a PR into the thread-diff shape", async () => {
    const { forge, call, project } = await setup();
    const projectId = await project();
    forge.views.set("27417", prOf(27417, { base: "t3/streaming-perf-1", head: "t3/streaming-perf-2" }));
    forge.diffs.set(27417, readFileSync(new URL("../../test/fixtures/gh/pr-diff.patch", import.meta.url), "utf8"));
    const { result } = await call("pr.diff", { projectId, number: 27417 });
    expect(result!.base).toBe("t3/streaming-perf-1");
    expect(result!.files).toHaveLength(4);
    expect(result!.files.every((f: { patch?: string }) => f.patch?.startsWith("diff --git "))).toBe(true);
  });

  it("passes detail, comments and reviews through to the forge", async () => {
    const { forge, call, project } = await setup();
    const projectId = await project();
    forge.details.set(3, [detailOf(prOf(3), { body: "Why" })]);
    expect((await call("pr.detail", { projectId, number: 3 })).result).toMatchObject({ body: "Why", viewer: "me" });
    expect((await call("pr.comment", { projectId, number: 3, body: "lgtm" })).result).toEqual({ ok: true });
    expect((await call("pr.review", { projectId, number: 3, event: "request_changes", body: "split it" })).result).toEqual({ ok: true });
    expect(forge.callsOf("comment")).toEqual([["/repos/Repo", 3, "lgtm"]]);
    expect(forge.callsOf("review")).toEqual([["/repos/Repo", 3, "request_changes", "split it"]]);
  });

  it("merges, then tells the linked thread so it settles and stops watching", async () => {
    const { engine, forge, call, project, thread } = await setup();
    const projectId = await project();
    const threadId = await thread(projectId);
    forge.list = [prOf(4)];
    await engine.dispatch({ type: "pr.update", threadId, pr: prOf(4) });
    await engine.dispatch({ type: "pr.watch", threadId, enabled: true });
    expect((await call("pr.merge", { projectId, number: 4, method: "squash" })).result).toEqual({ merged: true });
    expect(forge.callsOf("prMerge")).toEqual([["/repos/Repo", 4, { strategy: "squash", deleteBranch: true }]]);
    const t = engine.getModel().threads[threadId];
    expect(t?.pr).toMatchObject({ state: "merged", mergedAt: 5_000 });
    expect(t?.mergedAt).toBe(5_000);
    expect(t?.prWatch).toBeUndefined();
  });

  it("reports a refused merge with gh's reason", async () => {
    const { forge, call, project } = await setup();
    const projectId = await project();
    forge.list = [prOf(4)];
    forge.stateAfterMerge = "open";
    forge.mergeError = new GhError("gh pr merge failed", "Pull request is not mergeable: the base branch policy prohibits the merge.");
    expect((await call("pr.merge", { projectId, number: 4, method: "merge", deleteBranch: false })).result).toEqual({
      merged: false,
      error: "gh pr merge failed: Pull request is not mergeable: the base branch policy prohibits the merge.",
    });
  });
});
