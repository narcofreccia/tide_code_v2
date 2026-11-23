import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInside, safeRelativePath, toPosixRel } from "./paths.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() ?? "", { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("safeRelativePath", () => {
  it("accepts nested paths and rejects escapes", () => {
    expect(safeRelativePath("/repo", "src/a.ts")).toBe("src/a.ts");
    expect(safeRelativePath("/repo", "./src/../src/a.ts")).toBe("src/a.ts");
    expect(safeRelativePath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(() => safeRelativePath("/repo", "../secrets")).toThrow(/escapes/);
    expect(() => safeRelativePath("/repo", "src/../../secrets")).toThrow(/escapes/);
    expect(() => safeRelativePath("/repo", "/etc/passwd")).toThrow(/escapes/);
  });

  it("rejects the root unless allowRoot is set", () => {
    expect(() => safeRelativePath("/repo", ".")).toThrow(/escapes/);
    expect(safeRelativePath("/repo", ".", { allowRoot: true })).toBe("");
    expect(safeRelativePath("/repo", "", { allowRoot: true })).toBe("");
  });

  it("throws an invalid-params RpcException", () => {
    expect(() => safeRelativePath("/repo", "..")).toThrowError(expect.objectContaining({ code: "invalid-params" }));
  });

  // Windows semantics through node:path's win32 flavour: nothing here runs on Windows itself
  it("returns /-separated paths and holds containment with win32 paths", () => {
    expect(safeRelativePath("C:\\repo", "src/a.ts", {}, win32)).toBe("src/a.ts");
    expect(safeRelativePath("C:\\repo", "src\\ui\\a.ts", {}, win32)).toBe("src/ui/a.ts");
    expect(safeRelativePath("C:\\repo", "c:\\REPO\\src\\a.ts", {}, win32)).toBe("src/a.ts");
    expect(safeRelativePath("C:\\repo", ".git\\config", {}, win32)).toBe(".git/config");
    expect(safeRelativePath("C:\\repo", "", { allowRoot: true }, win32)).toBe("");
    for (const escape of ["..\\secrets", "src\\..\\..\\x", "D:\\x", "C:\\other\\x", "\\\\srv\\share\\x", "/x"]) {
      expect(() => safeRelativePath("C:\\repo", escape, {}, win32)).toThrow(/escapes/);
    }
  });
});

describe("toPosixRel", () => {
  it("converts win32 separators and leaves posix paths alone", () => {
    expect(toPosixRel("src\\ui\\a.ts", win32)).toBe("src/ui/a.ts");
    expect(toPosixRel("src/a\\b.ts", posix)).toBe("src/a\\b.ts");
  });
});

describe("resolveInside", () => {
  it("resolves real paths inside the cwd", async () => {
    const cwd = await temp("tide-paths-");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "x");
    const resolved = await resolveInside(cwd, "src/a.ts");
    expect(resolved.rel).toBe("src/a.ts");
    expect(resolved.abs).toBe(join(cwd, "src", "a.ts"));
  });

  it("allows paths that do not exist yet", async () => {
    const cwd = await temp("tide-paths-");
    const resolved = await resolveInside(cwd, "new/deep/file.ts");
    expect(resolved.rel).toBe("new/deep/file.ts");
  });

  it("rejects a symlink that points outside the cwd", async () => {
    const cwd = await temp("tide-paths-");
    const outside = await temp("tide-outside-");
    await writeFile(join(outside, "secret.txt"), "s3cret");
    await symlink(join(outside, "secret.txt"), join(cwd, "leak.txt"));
    await symlink(outside, join(cwd, "leakdir"));
    await expect(resolveInside(cwd, "leak.txt")).rejects.toThrow(/escapes/);
    await expect(resolveInside(cwd, "leakdir/secret.txt")).rejects.toThrow(/escapes/);
  });

  it("accepts a symlink that stays inside the cwd", async () => {
    const cwd = await temp("tide-paths-");
    await mkdir(join(cwd, "real"), { recursive: true });
    await writeFile(join(cwd, "real", "a.ts"), "x");
    await symlink(join(cwd, "real"), join(cwd, "link"));
    await expect(resolveInside(cwd, "link/a.ts")).resolves.toMatchObject({ rel: "link/a.ts" });
  });

  it("rejects lexical escapes before touching the disk", async () => {
    const cwd = await temp("tide-paths-");
    await expect(resolveInside(cwd, "../..")).rejects.toThrow(/escapes/);
  });
});
