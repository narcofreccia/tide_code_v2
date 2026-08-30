import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Git } from "../git.ts";

const run = promisify(execFile);

/** Deterministic, signature-free git identity so tests never touch the user's config. */
export const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Tide Test",
  GIT_AUTHOR_EMAIL: "test@tide.local",
  GIT_COMMITTER_NAME: "Tide Test",
  GIT_COMMITTER_EMAIL: "test@tide.local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export interface TempRepo {
  dir: string;
  git: Git;
  write(path: string, content: string): Promise<void>;
  writeBytes(path: string, bytes: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  commit(message: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTempRepo(prefix = "tide-git-"): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await run("git", ["-c", "init.defaultBranch=main", "init", "-q", dir], { env: GIT_TEST_ENV });
  await run("git", ["-C", dir, "config", "commit.gpgsign", "false"], { env: GIT_TEST_ENV });
  const git = new Git(dir, { env: GIT_TEST_ENV });
  const repo: TempRepo = {
    dir,
    git,
    async write(path, content) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    },
    async writeBytes(path, bytes) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, bytes);
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
  await repo.write("README.md", "# temp\n");
  await repo.commit("init");
  return repo;
}
