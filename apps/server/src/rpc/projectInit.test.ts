import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore, type EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { Git } from "../vcs/git.ts";
import { GIT_TEST_ENV } from "../vcs/testing/tempRepo.ts";
import { WorktreeManager } from "../vcs/worktrees.ts";
import { registerHandlers } from "./handlers.ts";
import { RpcRouter } from "./router.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup() {
  const store: EventStore = await openEventStore(":memory:");
  cleanups.push(async () => store.close());
  const engine = new Engine({ store });
  const router = new RpcRouter();
  registerHandlers(router, {
    engine,
    store,
    registry: new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } }),
    environmentId: "env",
    version: "test",
    startedAt: 0,
    git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }),
  });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error("no frame");
  };
  // macOS tmpdir is a symlink; the handler records real paths
  const parent = await realpath(await mkdtemp(join(tmpdir(), "tide-init-")));
  return { call, engine, parent };
}

describe("project.init", () => {
  it("creates the folder, a main branch with one commit, and the project; a worktree can branch off it", async () => {
    const { call, engine, parent } = await setup();
    const res = await call<{ projectId: string; rootPath: string }>("project.init", { parentPath: parent, name: "my-app" });
    expect(res.error).toBeUndefined();
    const rootPath = join(parent, "my-app");
    expect(res.result).toMatchObject({ rootPath });
    const git = new Git(rootPath, { env: GIT_TEST_ENV });
    expect(await git.isRepo()).toBe(true);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.run(["log", "--oneline"])).toContain("Initial commit");
    expect(engine.getModel().projects[res.result?.projectId ?? ""]).toMatchObject({ title: "my-app", rootPath });
    const worktrees = new WorktreeManager({ tideHome: join(parent, ".tide"), git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }), log: () => undefined });
    const project = engine.getModel().projects[res.result?.projectId ?? ""];
    if (!project) throw new Error("project missing");
    const wt = await worktrees.create(project, { id: "01THREAD", projectId: project.id, title: "first", provider: "claude", mode: "auto", interaction: "default", status: "idle", createdAt: 0, updatedAt: 0 });
    expect(wt.baseBranch).toBe("main");
  });
  it("accepts an empty existing folder, refuses a non-empty one, a bad name, a missing parent", async () => {
    const { call, parent } = await setup();
    await mkdir(join(parent, "empty"));
    expect((await call("project.init", { parentPath: parent, name: "empty" })).error).toBeUndefined();
    await mkdir(join(parent, "full"));
    await writeFile(join(parent, "full", "a.txt"), "x");
    expect((await call("project.init", { parentPath: parent, name: "full" })).error?.code).toBe("conflict");
    expect((await call("project.init", { parentPath: parent, name: "../oops" })).error?.code).toBe("invalid-params");
    expect((await call("project.init", { parentPath: join(parent, "nope"), name: "x" })).error?.code).toBe("not-found");
  });
});
