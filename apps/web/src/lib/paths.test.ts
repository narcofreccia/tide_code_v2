import { describe, expect, it } from "vitest";
import { basename, breadcrumbs, dirname, isAbsolutePath, joinPath, pathTail, relativeTo, samePath, separatorOf, splitLast } from "./paths.ts";

describe("isAbsolutePath", () => {
  it.each([
    ["/", true],
    ["/home/me/repo", true],
    ["C:\\", true],
    ["C:\\Users\\andre\\Desktop", true],
    ["c:/Users/andre", true],
    ["\\\\server\\share\\dir", true],
    ["\\\\server\\share", true],
    ["", false],
    ["repo", false],
    ["src/a.ts", false],
    ["src\\a.ts", false],
    ["C:", false],
    ["C:repo", false],
    ["~/code", false],
  ])("%s → %s", (path, expected) => {
    expect(isAbsolutePath(path)).toBe(expected);
  });
});

describe("basename", () => {
  it.each([
    ["/home/me/repo", "repo"],
    ["/home/me/repo/", "repo"],
    ["/", ""],
    ["C:\\Users\\andre\\Desktop", "Desktop"],
    ["C:\\Users\\andre\\Desktop\\", "Desktop"],
    ["C:/Users/andre", "andre"],
    ["C:\\", ""],
    ["\\\\server\\share\\dir", "dir"],
    ["\\\\server\\share", "share"],
    ["\\\\server\\share\\", "share"],
    ["src/lib/a.ts", "a.ts"],
    ["src\\lib\\a.ts", "a.ts"],
    ["a.ts", "a.ts"],
  ])("%s → %s", (path, expected) => {
    expect(basename(path)).toBe(expected);
  });
});

describe("dirname", () => {
  it.each([
    ["/home/me/repo", "/home/me"],
    ["/home/me/repo/", "/home/me"],
    ["/home", "/"],
    ["/", undefined],
    ["C:\\Users\\andre", "C:\\Users"],
    ["C:\\Users", "C:\\"],
    ["C:\\Users\\", "C:\\"],
    ["C:\\", undefined],
    ["C:/Users/andre", "C:/Users"],
    ["\\\\server\\share\\dir\\sub", "\\\\server\\share\\dir"],
    ["\\\\server\\share\\dir", "\\\\server\\share\\"],
    ["\\\\server\\share", undefined],
    ["src/a.ts", "src"],
    ["a.ts", undefined],
  ])("%s → %s", (path, expected) => {
    expect(dirname(path)).toBe(expected);
  });
});

describe("joinPath", () => {
  it.each([
    ["/home/me", "repo", "/home/me/repo"],
    ["/home/me/", "repo", "/home/me/repo"],
    ["/", "repo", "/repo"],
    ["/repo", "src/a.ts", "/repo/src/a.ts"],
    ["/repo", "/src/a.ts", "/repo/src/a.ts"],
    ["C:\\Users\\andre\\Desktop", "my-app", "C:\\Users\\andre\\Desktop\\my-app"],
    ["C:\\Users\\andre\\Desktop\\", "my-app", "C:\\Users\\andre\\Desktop\\my-app"],
    ["C:\\", "my-app", "C:\\my-app"],
    ["C:\\repo", "src/a.ts", "C:\\repo\\src\\a.ts"],
    ["C:/repo", "src/a.ts", "C:/repo/src/a.ts"],
    ["\\\\server\\share", "dir", "\\\\server\\share\\dir"],
    ["\\\\server\\share\\dir\\", "a.ts", "\\\\server\\share\\dir\\a.ts"],
    ["", "a.ts", "a.ts"],
  ])("%s + %s → %s", (dir, name, expected) => {
    expect(joinPath(dir, name)).toBe(expected);
  });
});

describe("separatorOf", () => {
  it("reads the separator the path already uses", () => {
    expect(separatorOf("/home/me")).toBe("/");
    expect(separatorOf("C:\\Users")).toBe("\\");
    expect(separatorOf("C:/Users")).toBe("/");
    expect(separatorOf("\\\\server\\share")).toBe("\\");
  });
});

describe("samePath", () => {
  it.each([
    ["/a/b", "/a/b/", true],
    ["/a/b", "/a/B", false],
    ["/", "/", true],
    ["C:\\Users\\Andre", "c:\\users\\andre\\", true],
    ["C:\\Users\\andre", "C:/Users/andre", true],
    ["C:\\", "C:\\", true],
    ["C:\\a", "D:\\a", false],
    ["\\\\server\\share\\dir", "\\\\SERVER\\share\\dir\\", true],
    ["/a/b", "C:\\a\\b", false],
  ])("%s vs %s → %s", (a, b, expected) => {
    expect(samePath(a, b)).toBe(expected);
  });
});

describe("relativeTo", () => {
  it.each([
    ["/repo/src/a.ts", "/repo", "src/a.ts"],
    ["/repo/src/a.ts", "/repo/", "src/a.ts"],
    ["/repo", "/repo", undefined],
    ["/repo-other/a.ts", "/repo", undefined],
    ["/elsewhere/a.ts", "/repo", undefined],
    ["/a.ts", "/", "a.ts"],
    ["C:\\wt\\t1\\src\\a.ts", "C:\\wt\\t1", "src/a.ts"],
    ["c:\\WT\\t1\\src\\a.ts", "C:\\wt\\t1\\", "src/a.ts"],
    ["C:/wt/t1/src/a.ts", "C:\\wt\\t1", "src/a.ts"],
    ["C:\\wt\\t10\\a.ts", "C:\\wt\\t1", undefined],
    ["D:\\wt\\t1\\a.ts", "C:\\wt\\t1", undefined],
    ["\\\\server\\share\\repo\\a.ts", "\\\\server\\share\\repo", "a.ts"],
    ["src/a.ts", "/repo", undefined],
    ["/repo/a.ts", "", undefined],
  ])("%s under %s → %s", (path, root, expected) => {
    expect(relativeTo(path, root)).toBe(expected);
  });
});

describe("pathTail", () => {
  it("keeps the last segments with the path's own separator", () => {
    expect(pathTail("/a/b/c/d/e.ts", 3)).toBe("…/c/d/e.ts");
    expect(pathTail("src/a.ts", 3)).toBe("src/a.ts");
    expect(pathTail("C:\\Users\\andre\\repo\\src\\a.ts", 3)).toBe("…\\repo\\src\\a.ts");
    expect(pathTail("\\\\server\\share\\a\\b\\c\\d.ts", 2)).toBe("…\\c\\d.ts");
  });
});

describe("splitLast", () => {
  it.each([
    ["src/lib/a.ts", { dir: "src/lib/", base: "a.ts" }],
    ["a.ts", { dir: "", base: "a.ts" }],
    ["C:\\repo\\a.ts", { dir: "C:\\repo\\", base: "a.ts" }],
    ["src\\lib/a.ts", { dir: "src\\lib/", base: "a.ts" }],
  ])("%s", (path, expected) => {
    expect(splitLast(path)).toEqual(expected);
  });
});

describe("breadcrumbs", () => {
  it("splits a POSIX path, root first", () => {
    expect(breadcrumbs("/Users/dev/tide")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "dev", path: "/Users/dev" },
      { label: "tide", path: "/Users/dev/tide" },
    ]);
    expect(breadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("splits a drive path, each crumb a real Windows path", () => {
    expect(breadcrumbs("C:\\Users\\andre")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "andre", path: "C:\\Users\\andre" },
    ]);
    expect(breadcrumbs("C:\\")).toEqual([{ label: "C:", path: "C:\\" }]);
  });

  it("keeps a UNC share as one root crumb", () => {
    expect(breadcrumbs("\\\\server\\share\\dir")).toEqual([
      { label: "\\\\server\\share", path: "\\\\server\\share\\" },
      { label: "dir", path: "\\\\server\\share\\dir" },
    ]);
  });
});
