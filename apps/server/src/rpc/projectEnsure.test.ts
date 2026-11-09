import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemoteUrl, type RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { SettingsStore } from "../settings.ts";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV } from "../vcs/testing/tempRepo.ts";
import { registerProjectEnsure } from "./projectEnsure.ts";
import { RpcRouter } from "./router.ts";

const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Ensured {
  projectId: string;
  rootPath: string;
  cloned: boolean;
}

async function setup(options: { agentThreadId?: string; projectsDir?: string } = {}) {
  const store = await openEventStore(":memory:");
  cleanups.push(async () => store.close());
  const engine = new Engine({ store });
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "tide-ensure-")));
  cleanups.push(() => rm(sandbox, { recursive: true, force: true }));
  // the origin: a bare repo named widget.git with one commit on main
  const source = await createTempRepo("tide-ensure-src-");
  cleanups.push(() => source.cleanup());
  const origin = join(sandbox, "widget.git");
  await run("git", ["clone", "-q", "--bare", source.dir, origin], { env: GIT_TEST_ENV });
  const remoteUrl = normalizeRemoteUrl(origin) ?? "";
  const settings = new SettingsStore({ log: () => undefined });
  if (options.projectsDir !== undefined) settings.set({ environment: { projectsDir: options.projectsDir } });
  const router = new RpcRouter();
  registerProjectEnsure(router, { engine, settings, git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }), homeDir: () => join(sandbox, "home") });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame), options.agentThreadId !== undefined ? { agentThreadId: options.agentThreadId } : {});
  let seq = 0;
  const call = async (params: Record<string, unknown> = {}): Promise<{ result?: Ensured; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, "project.ensure", { repo: { remoteUrl, cloneUrl: origin, defaultBranch: "main" }, title: "Widget", ...params });
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as Ensured };
    if (frame && "error" in frame) return { error: frame.error as { code: string; message: string } };
    throw new Error("no frame");
  };
  return { call, engine, sandbox, origin, remoteUrl };
}

describe("project.ensure", () => {
  it("clones into ~/tide-projects/<name> and creates the project with its repo identity", async () => {
    const { call, engine, sandbox, remoteUrl } = await setup();
    const res = await call();
    expect(res.error).toBeUndefined();
    const root = join(sandbox, "home", "tide-projects", "widget");
    expect(res.result).toMatchObject({ rootPath: root, cloned: true });
    expect(await new Git(root, { env: GIT_TEST_ENV }).currentBranch()).toBe("main");
    const project = engine.getModel().projects[res.result?.projectId ?? ""];
    expect(project).toMatchObject({ title: "Widget", rootPath: root });
    expect(project?.repo?.remoteUrl).toBe(remoteUrl);
  });

  it("honours parentDir, then settings.environment.projectsDir", async () => {
    const a = await setup();
    const parent = join(a.sandbox, "explicit");
    expect((await a.call({ parentDir: parent })).result).toMatchObject({ rootPath: join(parent, "widget"), cloned: true });
    const dir = join(tmpdir(), `tide-ensure-settings-${process.pid}-${Date.now()}`);
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const b = await setup({ projectsDir: dir });
    expect((await b.call()).result).toMatchObject({ rootPath: join(dir, "widget"), cloned: true });
  });

  it("reuses a live project with the same repo, unarchives an archived one", async () => {
    const { call, engine } = await setup();
    const first = await call();
    const again = await call();
    expect(again.result).toEqual({ projectId: first.result?.projectId, rootPath: first.result?.rootPath, cloned: false });
    const projectId = first.result?.projectId ?? "";
    await engine.dispatch({ type: "project.archive", projectId });
    expect(engine.getModel().projects[projectId]?.archivedAt).toBeDefined();
    const revived = await call();
    expect(revived.result).toMatchObject({ projectId, cloned: false });
    expect(engine.getModel().projects[projectId]?.archivedAt).toBeUndefined();
  });

  it("adopts an existing clone of the same repo at the target path", async () => {
    const { call, engine, sandbox, origin } = await setup();
    const parent = join(sandbox, "work");
    await mkdir(parent);
    await run("git", ["clone", "-q", origin, join(parent, "widget")], { env: GIT_TEST_ENV });
    const res = await call({ parentDir: parent });
    expect(res.result).toMatchObject({ rootPath: join(parent, "widget"), cloned: false });
    expect(engine.getModel().projects[res.result?.projectId ?? ""]?.repo).toBeDefined();
  });

  it("refuses a target path that is not a clone of the repo", async () => {
    const { call, sandbox } = await setup();
    const parent = join(sandbox, "work");
    await mkdir(join(parent, "widget"), { recursive: true });
    const res = await call({ parentDir: parent });
    expect(res.error?.code).toBe("conflict");
    expect(res.error?.message).toContain("is not a clone of");
  });

  it("surfaces git's stderr when the clone fails", async () => {
    const { call, sandbox } = await setup();
    const res = await call({ parentDir: join(sandbox, "p"), repo: { remoteUrl: "example.invalid/o/missing", cloneUrl: join(sandbox, "nope.git"), defaultBranch: "main" } });
    expect(res.error?.code).toBe("internal");
    expect(res.error?.message).toMatch(/git clone .* failed: .+/);
  });

  it("clones once for concurrent calls on the same repo", async () => {
    const { call, engine } = await setup();
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.result?.projectId).toBe(b.result?.projectId);
    expect(Object.keys(engine.getModel().projects)).toHaveLength(1);
  });

  it("is refused on agent sockets", async () => {
    const { call } = await setup({ agentThreadId: "t1" });
    expect((await call()).error?.code).toBe("forbidden");
  });
});
