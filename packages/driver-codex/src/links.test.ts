import { describe, expect, it } from "vitest";
import type { LinkedDir } from "@tide/contracts";
import { policyFor, writableRoots } from "./modes.ts";

const links: LinkedDir[] = [
  { path: "/repos/frontend/", label: "frontend", access: "write" },
  { path: "/repos/infra", label: "infra", access: "read" },
];

describe("codex writable roots for linked repos", () => {
  it("keeps the cwd first and adds only write links, normalised", () => {
    expect(writableRoots({ cwd: "/work/repo/", linkedDirs: links })).toEqual(["/work/repo", "/repos/frontend"]);
  });

  it("is the cwd alone when the thread has no links", () => {
    expect(writableRoots({ cwd: "/work/repo" })).toEqual(["/work/repo"]);
    expect(writableRoots({ cwd: "/work/repo", linkedDirs: [] })).toEqual(["/work/repo"]);
  });

  it("never lists the same root twice", () => {
    const duplicated: LinkedDir[] = [
      { path: "/repos/frontend", label: "a", access: "write" },
      { path: "/repos/frontend/./", label: "b", access: "write" },
    ];
    expect(writableRoots({ cwd: "/work/repo", linkedDirs: duplicated })).toEqual(["/work/repo", "/repos/frontend"]);
  });

  it("puts the write link in the sandbox policy, and leaves read-only links out of it", () => {
    const policy = policyFor("approval-required", writableRoots({ cwd: "/work/repo", linkedDirs: links }));
    expect(policy.sandbox).toBe("workspace-write");
    expect(policy.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: ["/work/repo", "/repos/frontend"] });
    // read-only links are readable because a workspace-write sandbox can read anywhere;
    // leaving them out of writableRoots is exactly what makes them read-only.
    const roots = policy.sandboxPolicy.type === "workspaceWrite" ? policy.sandboxPolicy.writableRoots : [];
    expect(roots).not.toContain("/repos/infra");
  });

  it("full-access still bypasses the sandbox entirely", () => {
    const policy = policyFor("full-access", writableRoots({ cwd: "/work/repo", linkedDirs: links }));
    expect(policy.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });
});
