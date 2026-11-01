import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "./git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "./testing/tempRepo.ts";
import { provisionWorktree } from "./worktreeInclude.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const git = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });

/** A repo whose .gitignore covers `binaries/`, `.env`, `*.log`; plus an empty destination dir. */
async function fixture(include?: string): Promise<{ repo: TempRepo; dest: string; provision: () => ReturnType<typeof provisionWorktree> }> {
  const repo = await createTempRepo("tide-wtinc-");
  const dest = await mkdtemp(join(tmpdir(), "tide-wtinc-dest-"));
  cleanups.push(() => repo.cleanup(), () => rm(dest, { recursive: true, force: true }));
  await repo.write(".gitignore", "binaries/\n.env\n*.log\n");
  await repo.commit("ignore");
  if (include !== undefined) await repo.write(".worktreeinclude", include);
  return { repo, dest, provision: () => provisionWorktree({ sourceRoot: repo.dir, worktreePath: dest, git }) };
}

describe("provisionWorktree", () => {
  it("copies ignored files listed in .worktreeinclude, including files under a dir pattern", async () => {
    const { repo, dest, provision } = await fixture("binaries/\n.env\n");
    await repo.write("binaries/ffmpeg-aarch64-apple-darwin", "ffmpeg");
    await repo.write("binaries/nested/sidecar", "sidecar");
    await repo.write(".env", "SECRET=1\n");
    await repo.write("debug.log", "not listed");
    const result = await provision();
    expect(result.copied).toEqual([".env", "binaries/ffmpeg-aarch64-apple-darwin", "binaries/nested/sidecar"]);
    expect(await readFile(join(dest, "binaries/nested/sidecar"), "utf8")).toBe("sidecar");
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
    await expect(lstat(join(dest, "debug.log"))).rejects.toThrow();
  });

  it("leaves tracked files and untracked unignored files alone", async () => {
    const { repo, dest, provision } = await fixture("README.md\nnotes.txt\n.env\n");
    await repo.write("notes.txt", "work in progress");
    await repo.write(".env", "x");
    const result = await provision();
    expect(result.copied).toEqual([".env"]);
    await expect(lstat(join(dest, "README.md"))).rejects.toThrow();
    await expect(lstat(join(dest, "notes.txt"))).rejects.toThrow();
  });

  it("never overwrites an existing destination", async () => {
    const { repo, dest, provision } = await fixture(".env\n");
    await repo.write(".env", "from source");
    await writeFile(join(dest, ".env"), "already here");
    const result = await provision();
    expect(result).toEqual({ copied: [], skipped: [".env"] });
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("already here");
  });

  it("keeps the executable bit", async () => {
    const { repo, dest, provision } = await fixture("binaries/\n");
    await repo.write("binaries/tool", "#!/bin/sh\n");
    await chmod(join(repo.dir, "binaries/tool"), 0o755);
    await provision();
    expect((await lstat(join(dest, "binaries/tool"))).mode & 0o777).toBe(0o755);
  });

  it("recreates a symlink as a symlink with the same target", async () => {
    const { repo, dest, provision } = await fixture("binaries/\n");
    await mkdir(join(repo.dir, "binaries"), { recursive: true });
    await symlink("../README.md", join(repo.dir, "binaries/link"));
    const result = await provision();
    expect(result.copied).toEqual(["binaries/link"]);
    expect((await lstat(join(dest, "binaries/link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dest, "binaries/link"))).toBe("../README.md");
  });

  it("is a no-op without a .worktreeinclude", async () => {
    const { repo, provision } = await fixture();
    await repo.write(".env", "x");
    expect(await provision()).toEqual({ copied: [], skipped: [] });
  });

  it("falls back to the worktree's committed .worktreeinclude", async () => {
    const { repo, dest, provision } = await fixture();
    await repo.write(".env", "x");
    await writeFile(join(dest, ".worktreeinclude"), ".env\n");
    expect((await provision()).copied).toEqual([".env"]);
  });

  it("rejects paths that escape the checkout", async () => {
    const { repo, dest } = await fixture(".env\n");
    await repo.write(".env", "x");
    // a git stand-in that reports an escaping path next to a real one
    class LyingGit extends Git {
      override async tryRunWithInput(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "../outside\0/etc/passwd\0.env\0", stderr: "" };
      }
    }
    const result = await provisionWorktree({ sourceRoot: repo.dir, worktreePath: dest, git: (cwd) => new LyingGit(cwd, { env: GIT_TEST_ENV }) });
    expect(result).toEqual({ copied: [".env"], skipped: ["../outside", "/etc/passwd"] });
  });

  it("does not throw when the source is not a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tide-wtinc-norepo-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, ".worktreeinclude"), ".env\n");
    const logs: string[] = [];
    const result = await provisionWorktree({ sourceRoot: dir, worktreePath: join(dir, "wt"), git, log: (m) => logs.push(m) });
    expect(result).toEqual({ copied: [], skipped: [] });
    expect(logs.some((m) => m.includes("listing failed"))).toBe(true);
  });
});
