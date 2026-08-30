import { stat } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Thread } from "@tide/contracts";
import { Git } from "./git.ts";
import { WorktreeManager, slugify } from "./worktrees.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "./testing/tempRepo.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(): Promise<{ repo: TempRepo; project: Project; manager: WorktreeManager; tideHome: string }> {
  const repo = await createTempRepo("tide-wt-repo-");
  const tideHome = await mkdtemp(join(tmpdir(), "tide-home-"));
  cleanups.push(() => repo.cleanup(), () => rm(tideHome, { recursive: true, force: true }));
  const project: Project = { id: "01PROJECTAAAAAA", title: "My Repo", rootPath: repo.dir, createdAt: 1, updatedAt: 1 };
  const manager = new WorktreeManager({ tideHome, git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }) });
  return { repo, project, manager, tideHome };
}

const thread = (id: string, title: string): Thread => ({
  id,
  projectId: "01PROJECTAAAAAA",
  title,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

describe("slugify", () => {
  it("normalizes titles", () => {
    expect(slugify("Fix the Login Bug!")).toBe("fix-the-login-bug");
    expect(slugify("  ---  ")).toBe("");
    expect(slugify("a".repeat(80))).toHaveLength(40);
  });
});

describe("WorktreeManager", () => {
  it("creates a worktree under TIDE_HOME on a tide/<slug> branch forked from the current branch", async () => {
    const { repo, project, manager, tideHome } = await fixture();
    const info = await manager.create(project, thread("01THREADAAAAAAAA", "Fix the Login Bug"));

    expect(info.branch).toBe("tide/fix-the-login-bug");
    expect(info.baseBranch).toBe("main");
    expect(info.worktreePath.startsWith(join(tideHome, "worktrees"))).toBe(true);
    expect(info.worktreePath.endsWith("aaaaaaaa")).toBe(true);
    expect((await stat(info.worktreePath)).isDirectory()).toBe(true);
    expect(await new Git(info.worktreePath, { env: GIT_TEST_ENV }).currentBranch()).toBe("tide/fix-the-login-bug");
    expect((await repo.git.worktreeList()).map((w) => w.branch)).toContain("tide/fix-the-login-bug");
  });

  it("falls back to the thread id when the title has no slug, and disambiguates a taken branch", async () => {
    const { project, manager } = await fixture();
    const untitled = await manager.create(project, thread("01THREADBBBBBBBB", "***"));
    expect(untitled.branch).toBe("tide/bbbbbbbb");

    await manager.create(project, thread("01THREADCCCCCCCC", "Same Title"));
    const clash = await manager.create(project, thread("01THREADDDDDDDDD", "Same Title"));
    expect(clash.branch).toBe("tide/same-title-dddddddd");
  });

  it("serializes concurrent creations on one repository", async () => {
    const { project, tideHome } = await fixture();
    let inFlight = 0;
    let maxInFlight = 0;
    class CountingGit extends Git {
      override async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await super.worktreeAdd(path, branch, base);
        } finally {
          inFlight--;
        }
      }
    }
    const counting = new WorktreeManager({ tideHome, git: (cwd) => new CountingGit(cwd, { env: GIT_TEST_ENV }) });
    const infos = await Promise.all([
      counting.create(project, thread("01THREAD00000001", "One")),
      counting.create(project, thread("01THREAD00000002", "Two")),
      counting.create(project, thread("01THREAD00000003", "Three")),
    ]);

    expect(maxInFlight).toBe(1);
    expect(new Set(infos.map((i) => i.branch)).size).toBe(3);
    expect(new Set(infos.map((i) => i.worktreePath)).size).toBe(3);
  });

  it("removes a worktree", async () => {
    const { repo, project, manager } = await fixture();
    const t = thread("01THREADEEEEEEEE", "Removable");
    const info = await manager.create(project, t);
    await manager.remove(project, { ...t, worktreePath: info.worktreePath });
    expect((await repo.git.worktreeList()).map((w) => w.path)).not.toContain(info.worktreePath);
    await expect(stat(info.worktreePath)).rejects.toThrow();
  });

  it("rejects a project root that is not a repository", async () => {
    const { manager } = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "tide-not-repo-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const notARepo: Project = { id: "01PROJECTBBBBBB", title: "Nope", rootPath: dir, createdAt: 1, updatedAt: 1 };
    await expect(manager.create(notARepo, thread("01THREADFFFFFFFF", "x"))).rejects.toThrow(/not a git repository/);
  });
});
