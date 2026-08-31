import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffResult, RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore, type EventStore } from "../orchestration/store.ts";
import { CheckpointService } from "../vcs/checkpoints.ts";
import { Git, WORKTREE } from "../vcs/git.ts";
import type { GhLike, PrRef } from "../vcs/gh.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { RpcRouter } from "./router.ts";
import { registerVcsHandlers } from "./vcs.ts";

const noGh: GhLike = {
  async hasGh() {
    return false;
  },
  async prCreate() {
    throw new Error("not used");
  },
  async prView(): Promise<PrRef | undefined> {
    return undefined;
  },
};

interface Setup {
  main: TempRepo;
  linked: TempRepo;
  readOnly: TempRepo;
  call<T>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }>;
  threadId: string;
  turnId: string;
  writeLinkId: string;
  readLinkId: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(): Promise<Setup> {
  const main = await createTempRepo("tide-links-main-");
  const linked = await createTempRepo("tide-links-web-");
  const readOnly = await createTempRepo("tide-links-infra-");
  const store: EventStore = await openEventStore(":memory:");
  cleanups.push(() => main.cleanup(), () => linked.cleanup(), () => readOnly.cleanup(), async () => store.close());

  const engine = new Engine({ store });
  const git = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });
  const router = new RpcRouter();
  registerVcsHandlers(router, { engine, checkpoints: new CheckpointService({ git }), gh: noGh, git });

  const project = (await engine.dispatch({ type: "project.create", title: "Repo", rootPath: main.dir })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const projectId = project.project.id;
  const added = await engine.dispatch({ type: "project.link.add", projectId, path: linked.dir, label: "frontend" });
  const writeLinkId = added.events[0]?.event.type === "project.link.added" ? added.events[0].event.link.id : "";
  const addedRo = await engine.dispatch({ type: "project.link.add", projectId, path: readOnly.dir, label: "infra", access: "read" });
  const readLinkId = addedRo.events[0]?.event.type === "project.link.added" ? addedRo.events[0].event.link.id : "";

  const thread = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");
  const turn = (await engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "go" })).events[0]?.event;
  if (turn?.type !== "turn.requested") throw new Error("expected turn.requested");

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
  return { main, linked, readOnly, call, threadId: thread.thread.id, turnId: turn.turn.id, writeLinkId, readLinkId };
}

describe("linked-repo change attribution", () => {
  it("reports the working-tree status of write links only", async () => {
    const s = await setup();
    await s.linked.write("src/app.tsx", "changed\n");
    await s.linked.write("README.md", "# web edited\n");
    await s.readOnly.write("main.tf", "should not be reported\n");

    const diff = await s.call<DiffResult>("vcs.turnDiff", { threadId: s.threadId, turnId: s.turnId });
    const linked = diff.result?.linked ?? [];
    expect(linked.map((row) => row.label)).toEqual(["frontend"]);
    expect(linked[0]?.path).toBe(s.linked.dir);
    expect(linked[0]?.files.map((file) => file.path).sort()).toEqual(["README.md", "src/app.tsx"]);
    expect(linked[0]?.files.find((file) => file.path === "src/app.tsx")?.status).toBe("??");
  });

  it("rides along on vcs.threadDiff too, and is absent when nothing changed", async () => {
    const s = await setup();
    const clean = await s.call<DiffResult>("vcs.threadDiff", { threadId: s.threadId });
    expect(clean.result?.linked).toBeUndefined();
    await s.linked.write("a.txt", "x\n");
    const dirty = await s.call<DiffResult>("vcs.threadDiff", { threadId: s.threadId });
    expect(dirty.result?.linked?.[0]?.files).toHaveLength(1);
  });
});

describe("vcs.linkedRevert", () => {
  it("restores tracked files and removes only the untracked files asked for", async () => {
    const s = await setup();
    await s.linked.write("README.md", "# edited\n");
    await s.linked.write("junk.txt", "untracked\n");
    await s.linked.write("keep.txt", "also untracked\n");

    const result = await s.call<{ reverted: string[] }>("vcs.linkedRevert", {
      threadId: s.threadId,
      linkId: s.writeLinkId,
      files: ["README.md", "junk.txt"],
    });
    expect(result.result?.reverted.sort()).toEqual(["README.md", "junk.txt"]);
    expect(await readFile(join(s.linked.dir, "README.md"), "utf8")).toBe("# temp\n");
    await expect(readFile(join(s.linked.dir, "junk.txt"), "utf8")).rejects.toThrow();
    // an untracked file the caller did not name is left alone
    expect(await readFile(join(s.linked.dir, "keep.txt"), "utf8")).toBe("also untracked\n");
  });

  it("with no file list restores every tracked change and keeps untracked files", async () => {
    const s = await setup();
    await s.linked.write("README.md", "# edited\n");
    await s.linked.write("junk.txt", "untracked\n");
    const result = await s.call<{ reverted: string[] }>("vcs.linkedRevert", { threadId: s.threadId, linkId: s.writeLinkId });
    expect(result.result?.reverted).toEqual(["README.md"]);
    expect(await readFile(join(s.linked.dir, "junk.txt"), "utf8")).toBe("untracked\n");
  });

  it("never touches anything outside the link", async () => {
    const s = await setup();
    await s.main.write("README.md", "# main edited\n");
    const escape = await s.call("vcs.linkedRevert", { threadId: s.threadId, linkId: s.writeLinkId, files: ["../README.md"] });
    expect(escape.error?.code).toBe("invalid-params");
    expect(await readFile(join(s.main.dir, "README.md"), "utf8")).toBe("# main edited\n");
  });

  it("refuses a read-only link and an unknown one", async () => {
    const s = await setup();
    expect((await s.call("vcs.linkedRevert", { threadId: s.threadId, linkId: s.readLinkId })).error?.code).toBe("conflict");
    expect((await s.call("vcs.linkedRevert", { threadId: s.threadId, linkId: "ghost" })).error?.code).toBe("not-found");
  });
});

describe("vcs.fileAt for linked repos", () => {
  it("serves absolute paths inside a link from that repo: HEAD for any ref, working tree for WORKTREE", async () => {
    const s = await setup();
    await s.linked.write("README.md", "# web edited\n");
    const abs = `${s.linked.dir}/README.md`;
    const before = await s.call<{ content?: string }>("vcs.fileAt", { threadId: s.threadId, ref: "refs/tide/whatever", path: abs });
    const after = await s.call<{ content?: string }>("vcs.fileAt", { threadId: s.threadId, ref: WORKTREE, path: abs });
    expect(before.result?.content).not.toBe("# web edited\n");
    expect(after.result?.content).toBe("# web edited\n");
  });

  it("still rejects absolute paths that are neither in the thread repo nor in a link", async () => {
    const s = await setup();
    const res = await s.call<{ content?: string }>("vcs.fileAt", { threadId: s.threadId, ref: WORKTREE, path: "/etc/hosts" });
    expect(res.error?.code).toBe("invalid-params");
  });
});
