import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Git } from "../git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "./tempRepo.ts";

const run = promisify(execFile);

/**
 * R17: one repository on two "machines". `origin` is a bare repo; `a` is the owner checkout
 * (a TempRepo whose `main` tracks origin), `b` a second clone that pushes behind A's back.
 */
export interface RemotePair {
  origin: string;
  a: TempRepo;
  b: TempRepo;
  cleanup(): Promise<void>;
}

/** A clone of `origin` with TempRepo helpers (identity from GIT_TEST_ENV, no signing). */
async function cloneOf(origin: string): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), "tide-clone-"));
  await rm(dir, { recursive: true, force: true });
  await run("git", ["clone", "-q", origin, dir], { env: GIT_TEST_ENV });
  await run("git", ["-C", dir, "config", "commit.gpgsign", "false"], { env: GIT_TEST_ENV });
  const git = new Git(dir, { env: GIT_TEST_ENV });
  return {
    dir,
    git,
    async write(path, content) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content, "utf8");
    },
    async writeBytes(path, bytes) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), bytes);
    },
    async remove(path) {
      await rm(join(dir, path), { recursive: true, force: true });
    },
    async commit(message) {
      await git.run(["add", "-A"]);
      await git.run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
      return (await git.revParse("HEAD")) ?? "";
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createRemotePair(): Promise<RemotePair> {
  const origin = await mkdtemp(join(tmpdir(), "tide-origin-"));
  await run("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: GIT_TEST_ENV });
  const a = await createTempRepo("tide-owner-");
  await a.git.run(["remote", "add", "origin", origin]);
  await a.git.run(["push", "-q", "-u", "origin", "main"]);
  const b = await cloneOf(origin);
  return {
    origin,
    a,
    b,
    async cleanup() {
      await Promise.all([a.cleanup(), b.cleanup(), rm(origin, { recursive: true, force: true })]);
    },
  };
}
