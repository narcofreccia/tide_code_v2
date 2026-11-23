import { describe, expect, it } from "vitest";
import { expandHome, normalizeRootPath, windowsFolderNameProblem } from "./hostPath.ts";

// Windows rules exercised through `platform` and node:path's win32 flavour; nothing here runs on Windows.
describe("expandHome", () => {
  it("expands ~ and ~/ the same way on every platform", () => {
    expect(expandHome("~", "/home/me", "linux")).toBe("/home/me");
    expect(expandHome("~/code", "/home/me", "darwin")).toBe("/home/me/code");
    expect(expandHome("~/code", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code");
  });
  it("expands ~\\ only on Windows and leaves other paths alone", () => {
    expect(expandHome("~\\code\\tide", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\tide");
    expect(expandHome("~\\code", "/home/me", "linux")).toBe("~\\code");
    expect(expandHome("D:\\code", "C:\\Users\\me", "win32")).toBe("D:\\code");
    expect(expandHome("~other/x", "/home/me", "linux")).toBe("~other/x");
  });
});

describe("normalizeRootPath", () => {
  it("gives one spelling to the same Windows folder", () => {
    const forms = ["C:\\Users\\me\\repo", "c:\\Users\\me\\repo", "C:/Users/me/repo", "c:/Users/me/repo/", "C:\\Users\\me\\.\\x\\..\\repo\\"];
    for (const form of forms) expect(normalizeRootPath(form, "win32")).toBe("C:\\Users\\me\\repo");
    expect(normalizeRootPath("\\\\server\\share\\repo\\", "win32")).toBe("\\\\server\\share\\repo");
  });
  it("leaves POSIX and relative paths unchanged", () => {
    expect(normalizeRootPath("/repo/", "darwin")).toBe("/repo/");
    expect(normalizeRootPath("/a/../repo", "linux")).toBe("/a/../repo");
    expect(normalizeRootPath("repo", "win32")).toBe("repo");
  });
});

describe("windowsFolderNameProblem", () => {
  it("refuses device names and trailing dots on Windows only", () => {
    for (const name of ["con", "NUL", "aux.txt", "com1", "LPT9.repo", "app."]) expect(windowsFolderNameProblem(name, "win32")).toBeDefined();
    for (const name of ["console", "app", "my.app", "com10"]) expect(windowsFolderNameProblem(name, "win32")).toBeUndefined();
    for (const name of ["con", "app."]) expect(windowsFolderNameProblem(name, "darwin")).toBeUndefined();
  });
});
