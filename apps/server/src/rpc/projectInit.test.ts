import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

async function setup(gitEnv: NodeJS.ProcessEnv = GIT_TEST_ENV) {
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
    git: (cwd) => new Git(cwd, { env: gitEnv }),
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
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
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

  it("regression: a global config that signs commits with an ssh key does not break (or hang) the first commit", async () => {
    // the Windows report: commit.gpgsign + gpg.format=ssh + a passphrase key made the init commit wait for a
    // passphrase until the 120 s timeout. A key file that does not exist makes an unguarded commit fail fast instead.
    const home = await realpath(await mkdtemp(join(tmpdir(), "tide-signcfg-")));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const config = join(home, "gitconfig");
    await writeFile(config, `[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${join(home, "id_ed25519.pub")}\n`);
    const { call, parent } = await setup({ ...GIT_TEST_ENV, GIT_CONFIG_GLOBAL: config });
    const res = await call<{ rootPath: string }>("project.init", { parentPath: parent, name: "signed" });
    expect(res.error).toBeUndefined();
    const git = new Git(join(parent, "signed"), { env: GIT_TEST_ENV });
    expect(await git.run(["log", "--format=%s %G?"])).toBe("Initial commit N\n");
  });

  describe("when git fails", () => {
    /** a `git` that runs the real one except for `commit`, which fails like a signing helper would */
    async function failingCommitEnv(onCommit = ""): Promise<NodeJS.ProcessEnv> {
      const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const bin = await mkdtemp(join(tmpdir(), "tide-gitstub-"));
      cleanups.push(() => rm(bin, { recursive: true, force: true }));
      const script = `#!/bin/sh\nfor a in "$@"; do [ "$a" = commit ] && { ${onCommit} echo "error: Couldn't load public key: passphrase required" >&2; echo "fatal: failed to write commit object" >&2; exit 128; }; done\nexec "${realGit}" "$@"\n`;
      await writeFile(join(bin, "git"), script);
      await chmod(join(bin, "git"), 0o755);
      return { ...GIT_TEST_ENV, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    }
    const posixOnly = process.platform === "win32" ? it.skip : it;

    posixOnly("reports git's reason instead of 'internal error' and removes the folder it created, so the name can be retried", async () => {
      const { call, engine, parent } = await setup(await failingCommitEnv());
      const res = await call("project.init", { parentPath: parent, name: "retry-me" });
      expect(res.error).toEqual({ code: "internal", message: `could not set up a git repository in ${join(parent, "retry-me")}: error: Couldn't load public key: passphrase required` });
      expect(await readdir(parent)).toEqual([]);
      expect(Object.keys(engine.getModel().projects)).toEqual([]);
    });

    posixOnly("in a folder that already existed, takes away only the .git it made and keeps the folder", async () => {
      const { call, parent } = await setup(await failingCommitEnv());
      await mkdir(join(parent, "existing"));
      expect((await call("project.init", { parentPath: parent, name: "existing" })).error?.code).toBe("internal");
      expect(await readdir(parent)).toEqual(["existing"]);
      expect(await readdir(join(parent, "existing"))).toEqual([]);
    });

    posixOnly("leaves a folder alone once anything besides its .git is in it", async () => {
      // something (a hook, the user) wrote a file while init ran: nothing is removed
      const { call, parent } = await setup(await failingCommitEnv("echo x > stray.txt;"));
      expect((await call("project.init", { parentPath: parent, name: "busy" })).error?.code).toBe("internal");
      expect((await readdir(join(parent, "busy"))).sort()).toEqual([".git", "stray.txt"]);
    });
  });
});
