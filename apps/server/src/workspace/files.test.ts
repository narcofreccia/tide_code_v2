import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { FileService, mtimeOf } from "./files.ts";

const THREAD = "th-1";
const gitFactory = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(): Promise<{ repo: TempRepo; files: FileService }> {
  const repo = await createTempRepo("tide-files-");
  cleanups.push(() => repo.cleanup());
  const files = new FileService({ cwdFor: () => repo.dir, git: gitFactory });
  return { repo, files };
}

describe("FileService.list", () => {
  it("sorts dirs first then files case-insensitively and hides .git", async () => {
    const { repo, files } = await setup();
    await repo.write("src/a.ts", "a");
    await repo.write("Zeta.md", "z");
    await repo.write("beta.md", "b");
    await repo.write("Alpha/keep.txt", "k");
    const entries = await files.list(THREAD);
    expect(entries.map((e) => e.name)).toEqual(["Alpha", "src", "beta.md", "README.md", "Zeta.md"]);
    expect(entries.every((e) => e.name !== ".git")).toBe(true);
    expect(entries.find((e) => e.name === "src")?.kind).toBe("dir");
    expect(entries.find((e) => e.name === "Zeta.md")?.size).toBe(1);
  });

  it("flags gitignored entries in one batch", async () => {
    const { repo, files } = await setup();
    await repo.write(".gitignore", "node_modules/\n*.log\n");
    await repo.write("node_modules/pkg/index.js", "x");
    await repo.write("debug.log", "x");
    await repo.write("keep.ts", "x");
    await repo.commit("ignores");
    const entries = await files.list(THREAD);
    const byName = new Map(entries.map((e) => [e.name, e.ignored]));
    expect(byName.get("node_modules")).toBe(true);
    expect(byName.get("debug.log")).toBe(true);
    expect(byName.get("keep.ts")).toBe(false);
  });

  it("lists a nested directory and rejects escapes", async () => {
    const { repo, files } = await setup();
    await repo.write("src/nested/a.ts", "a");
    const entries = await files.list(THREAD, "src");
    expect(entries.map((e) => e.path)).toEqual(["src/nested"]);
    await expect(files.list(THREAD, "../..")).rejects.toThrow(/escapes/);
  });
});

describe("FileService.read", () => {
  it("reads utf-8 text", async () => {
    const { repo, files } = await setup();
    await repo.write("hello.txt", "héllo\n");
    const result = await files.read(THREAD, "hello.txt");
    expect(result.binary).toBe(false);
    expect(result.content).toBe("héllo\n");
    expect(result.size).toBeGreaterThan(0);
  });

  it("reports a NUL-containing file as binary without content", async () => {
    const { repo, files } = await setup();
    await repo.writeBytes("blob.bin", Buffer.from([0x41, 0x00, 0x42]));
    const result = await files.read(THREAD, "blob.bin");
    expect(result.binary).toBe(true);
    expect(result.content).toBeUndefined();
  });

  it("does not read a file past the size cap", async () => {
    const { repo, files } = await setup();
    await repo.writeBytes("big.txt", Buffer.alloc(5 * 1024 * 1024 + 1, 0x41));
    const result = await files.read(THREAD, "big.txt");
    expect(result.binary).toBe(true);
    expect(result.content).toBeUndefined();
  });

  it("maps a missing file to not-found", async () => {
    const { files } = await setup();
    await expect(files.read(THREAD, "nope.txt")).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("FileService.write", () => {
  it("writes atomically and leaves no temp files behind", async () => {
    const { repo, files } = await setup();
    await repo.write("a.ts", "old");
    const { mtime } = await files.write(THREAD, "a.ts", "new");
    expect(await readFile(join(repo.dir, "a.ts"), "utf8")).toBe("new");
    expect(mtime).toBe(mtimeOf((await stat(join(repo.dir, "a.ts"))).mtimeMs));
    const entries = await files.list(THREAD);
    expect(entries.some((e) => e.name.endsWith(".tide-tmp"))).toBe(false);
  });

  it("honours ifMtime and reports a conflict when the file moved on", async () => {
    const { repo, files } = await setup();
    await repo.write("a.ts", "old");
    const read = await files.read(THREAD, "a.ts");
    await expect(files.write(THREAD, "a.ts", "ok", read.mtime)).resolves.toMatchObject({ mtime: expect.any(Number) });

    await writeFile(join(repo.dir, "a.ts"), "changed by someone else");
    await expect(files.write(THREAD, "a.ts", "boom", read.mtime - 1000)).rejects.toMatchObject({
      code: "conflict",
      message: "file changed on disk",
    });
    expect(await readFile(join(repo.dir, "a.ts"), "utf8")).toBe("changed by someone else");
  });

  it("treats a missing file as a conflict when ifMtime is given", async () => {
    const { files } = await setup();
    await expect(files.write(THREAD, "ghost.ts", "x", 1)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("FileService create / rename / delete", () => {
  it("creates files and directories", async () => {
    const { repo, files } = await setup();
    await files.create(THREAD, "deep/dir", "dir");
    await files.create(THREAD, "deep/dir/new.ts", "file");
    expect(await readFile(join(repo.dir, "deep/dir/new.ts"), "utf8")).toBe("");
    // mkdir -p is idempotent for dirs, but an existing file is a conflict
    await files.create(THREAD, "deep/dir", "dir");
    await expect(files.create(THREAD, "deep/dir/new.ts", "file")).rejects.toMatchObject({ code: "conflict" });
  });

  it("renames and refuses to clobber", async () => {
    const { repo, files } = await setup();
    await repo.write("a.ts", "a");
    await repo.write("b.ts", "b");
    await files.rename(THREAD, "a.ts", "sub/c.ts");
    expect(await readFile(join(repo.dir, "sub/c.ts"), "utf8")).toBe("a");
    await expect(files.rename(THREAD, "b.ts", "sub/c.ts")).rejects.toMatchObject({ code: "conflict" });
    await expect(files.rename(THREAD, "b.ts", "../escape.ts")).rejects.toThrow(/escapes/);
  });

  it("deletes files and directories recursively but never the cwd", async () => {
    const { repo, files } = await setup();
    await repo.write("dir/one.ts", "1");
    await repo.write("dir/two/three.ts", "3");
    await files.delete(THREAD, "dir");
    await expect(files.read(THREAD, "dir/one.ts")).rejects.toMatchObject({ code: "not-found" });
    await expect(files.delete(THREAD, ".")).rejects.toMatchObject({ code: "invalid-params" });
    await expect(files.delete(THREAD, "")).rejects.toMatchObject({ code: "invalid-params" });
    await expect(files.delete(THREAD, ".git/config")).rejects.toMatchObject({ code: "invalid-params" });
    await expect(files.delete(THREAD, "gone.ts")).rejects.toMatchObject({ code: "not-found" });
  });
});
