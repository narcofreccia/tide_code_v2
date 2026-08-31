import { describe, expect, it } from "vitest";
import type { Project, Thread } from "@tide/contracts";
import { composeSystemPromptAppend, linkedRepoPreamble, resolveLinkedDirs } from "./links.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { createFakeDriver } from "./testing/fakeDriver.ts";

const project = (patch: Partial<Project> = {}): Project => ({
  id: "p1",
  title: "API",
  rootPath: "/repos/api",
  links: [
    { id: "l1", path: "/repos/frontend", label: "frontend", note: "React web client", access: "write" },
    { id: "l2", path: "/repos/infra", label: "infra", note: "Terraform for staging", access: "read" },
  ],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const thread = (patch: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p1",
  title: "Thread",
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe("resolveLinkedDirs", () => {
  it("joins the thread's selection with the project's links", () => {
    const dirs = resolveLinkedDirs(thread({ links: [{ linkId: "l1", access: "write" }] }), project());
    expect(dirs).toEqual([{ path: "/repos/frontend", label: "frontend", note: "React web client", access: "write" }]);
  });

  it("falls back to every project link when the thread recorded no selection", () => {
    expect(resolveLinkedDirs(thread(), project()).map((d) => d.label)).toEqual(["frontend", "infra"]);
  });

  it("never grants more access than the project link does", () => {
    const dirs = resolveLinkedDirs(thread({ links: [{ linkId: "l2", access: "write" }] }), project());
    expect(dirs[0]?.access).toBe("read");
  });

  it("drops a link that has since been removed from the project, and returns nothing for a project with none", () => {
    expect(resolveLinkedDirs(thread({ links: [{ linkId: "gone", access: "write" }] }), project())).toEqual([]);
    const noLinks: Project = { id: "p2", title: "Solo", rootPath: "/repos/solo", createdAt: 0, updatedAt: 0 };
    expect(resolveLinkedDirs(thread(), noLinks)).toEqual([]);
  });

  it("points at the linked repo's real path even when the thread runs in a worktree", () => {
    const dirs = resolveLinkedDirs(thread({ worktreePath: "/tide/worktrees/api-t1" }), project());
    expect(dirs.map((d) => d.path)).toEqual(["/repos/frontend", "/repos/infra"]);
  });
});

describe("linkedRepoPreamble", () => {
  it("names each link with its path, access and note, and stays short", () => {
    const text = linkedRepoPreamble(project(), resolveLinkedDirs(thread(), project()))!;
    expect(text).toContain("## Linked repositories");
    expect(text).toContain("This project (API) is linked to other repositories you may need:");
    expect(text).toContain("- frontend — /repos/frontend (read & write): React web client");
    expect(text).toContain("- infra — /repos/infra (read-only): Terraform for staging");
    expect(text).toContain("Read-only links must not be modified.");
    expect(text.split("\n")).toHaveLength(5);
  });

  it("is skipped entirely when there are no links", () => {
    expect(linkedRepoPreamble(project({ links: [] }), [])).toBeUndefined();
    expect(composeSystemPromptAppend(undefined, "  ")).toBeUndefined();
    expect(composeSystemPromptAppend("a", undefined, "b")).toBe("a\n\nb");
  });
});

describe("SessionDirectory link plumbing", () => {
  const setup = (): { sessions: SessionDirectory; claude: ReturnType<typeof createFakeDriver>["control"] } => {
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
    const claude = createFakeDriver("claude");
    registry.register(claude.driver);
    return { sessions: new SessionDirectory({ registry, autoReap: false, log: () => undefined }), claude: claude.control };
  };

  it("opens the session with the thread's links and the preamble", async () => {
    const { sessions, claude } = setup();
    await sessions.getOrOpen(thread(), project());
    expect(claude.opened[0]?.linkedDirs?.map((d) => `${d.label}:${d.access}`)).toEqual(["frontend:write", "infra:read"]);
    expect(claude.opened[0]?.systemPromptAppend).toContain("## Linked repositories");
    expect(claude.opened[0]?.cwd).toBe("/repos/api");
  });

  it("passes neither field when the project has no links", async () => {
    const { sessions, claude } = setup();
    await sessions.getOrOpen(thread(), project({ links: [] }));
    expect(claude.opened[0]?.linkedDirs).toBeUndefined();
    expect(claude.opened[0]?.systemPromptAppend).toBeUndefined();
  });
});
