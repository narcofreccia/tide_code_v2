import { describe, expect, it } from "vitest";
import { absolutize, isUnder, parseLinkedDirs, readOnlyLinkFor, toolTargetPath, type LinkedDirWire } from "./protocol.ts";

const links: LinkedDirWire[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra/", label: "infra", access: "read", note: "Terraform for staging" },
];

describe("pi bridge link helpers", () => {
  it("normalises trailing slashes, `.` and `..` before comparing", () => {
    expect(isUnder("/repos/infra/", "/repos/infra/main.tf")).toBe(true);
    expect(isUnder("/repos/infra", "/repos/infra")).toBe(true);
    expect(isUnder("/repos/infra", "/repos/./infra/a/../b.tf")).toBe(true);
    expect(isUnder("/repos/infra", "/repos/infrastructure/x")).toBe(false);
    expect(isUnder("/repos/infra", "/repos/other/x")).toBe(false);
  });

  it("resolves relative tool paths against the thread's cwd", () => {
    expect(absolutize("/work/repo", "src/a.ts")).toBe("/work/repo/src/a.ts");
    expect(absolutize("/work/repo", "/repos/infra/main.tf")).toBe("/repos/infra/main.tf");
  });

  it("reads the target path out of pi's tool inputs", () => {
    expect(toolTargetPath({ path: "a.ts" })).toBe("a.ts");
    expect(toolTargetPath({ file_path: "b.ts" })).toBe("b.ts");
    expect(toolTargetPath({ command: "ls" })).toBeUndefined();
  });

  it("survives a missing or malformed TIDE_LINKED_DIRS", () => {
    expect(parseLinkedDirs(undefined)).toEqual([]);
    expect(parseLinkedDirs("not json")).toEqual([]);
    expect(parseLinkedDirs('[{"path":"/a"}]')).toEqual([]);
    expect(parseLinkedDirs(JSON.stringify(links))).toHaveLength(2);
  });
});

describe("pi read-only link enforcement", () => {
  it("blocks a write under a read-only link", () => {
    expect(readOnlyLinkFor("write", { path: "/repos/infra/main.tf" }, "/work/repo", links)?.label).toBe("infra");
    expect(readOnlyLinkFor("edit", { file_path: "/repos/infra/main.tf" }, "/work/repo", links)?.label).toBe("infra");
    // relative paths are resolved against the linked repo when that is the cwd
    expect(readOnlyLinkFor("edit", { path: "main.tf" }, "/repos/infra", links)?.label).toBe("infra");
  });

  it("allows a write under a write link — pi has no cwd gate, so nothing extra is needed", () => {
    expect(readOnlyLinkFor("edit", { file_path: "/repos/frontend/app.tsx" }, "/work/repo", links)).toBeUndefined();
  });

  it("never blocks a read, under either kind of link", () => {
    expect(readOnlyLinkFor("read", { path: "/repos/infra/main.tf" }, "/work/repo", links)).toBeUndefined();
    expect(readOnlyLinkFor("grep", { path: "/repos/infra" }, "/work/repo", links)).toBeUndefined();
  });

  it("leaves the thread's own cwd alone", () => {
    expect(readOnlyLinkFor("edit", { file_path: "/work/repo/src/a.ts" }, "/work/repo", links)).toBeUndefined();
    expect(readOnlyLinkFor("edit", { path: "src/a.ts" }, "/work/repo", links)).toBeUndefined();
    expect(readOnlyLinkFor("edit", { path: "src/a.ts" }, "/work/repo", [])).toBeUndefined();
  });
});
