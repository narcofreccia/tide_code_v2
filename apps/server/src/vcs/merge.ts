import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MergeStrategy, Project, PullRequest, Thread } from "@tide/contracts";
import { Git } from "./git.ts";
import type { GhLike } from "./gh.ts";

export type MergeResult =
  | { outcome: "merged"; sha?: string; pr?: PullRequest; note?: string }
  | { outcome: "conflicted"; files: string[] }
  | { outcome: "error"; error: string };

export interface MergeBackOptions {
  /** `<TIDE_HOME>/worktrees`; the scratch worktree lives at `<worktreeRoot>/.merge-<threadId>` */
  worktreeRoot: string;
  gh: GhLike;
  git?: (cwd: string) => Git;
  now?: () => number;
  /** waits between `gh pr view` polls; injectable so tests never sleep */
  delay?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

/** Used only when the repo has no identity of its own, so a merge commit can always be written. */
const FALLBACK_IDENTITY = ["-c", "user.name=Tide", "-c", "user.email=tide@localhost"];
const NO_SIGN = ["-c", "commit.gpgsign=false"];

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Lands a thread's branch on its base branch. The user's main checkout is never used as the
 * merge workspace: the merge runs in a throwaway detached worktree of the base, the base ref is
 * then moved to the result, and a checkout that has the base branch checked out is only
 * fast-forwarded when it is clean. With an open PR the merge goes through GitHub instead.
 */
export class MergeBack {
  #worktreeRoot: string;
  #gh: GhLike;
  #git: (cwd: string) => Git;
  #now: () => number;
  #delay: (ms: number) => Promise<void>;
  #pollAttempts: number;
  #pollIntervalMs: number;
  #log: (msg: string, data?: unknown) => void;

  constructor(options: MergeBackOptions) {
    this.#worktreeRoot = options.worktreeRoot;
    this.#gh = options.gh;
    this.#git = options.git ?? ((cwd) => new Git(cwd));
    this.#now = options.now ?? (() => Date.now());
    this.#delay = options.delay ?? realDelay;
    this.#pollAttempts = options.pollAttempts ?? 10;
    this.#pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.#log = options.log ?? (() => undefined);
  }

  tempPath(threadId: string): string {
    return join(this.#worktreeRoot, `.merge-${threadId}`);
  }

  /** True when the merge should go through `gh pr merge` rather than locally. */
  async usesPr(thread: Thread): Promise<boolean> {
    return thread.pr?.state === "open" && this.#gh.prMerge !== undefined && (await this.#gh.hasGh());
  }

  async merge(project: Project, thread: Thread, strategy: MergeStrategy, deleteBranch: boolean): Promise<MergeResult> {
    try {
      await this.#commitPending(thread);
      if (await this.usesPr(thread)) return await this.#viaPr(project, thread, strategy, deleteBranch);
      return await this.#local(project, thread, strategy);
    } catch (err) {
      return { outcome: "error", error: message(err) };
    }
  }

  /** The agent rarely commits its own work: whatever is in the worktree is what the user saw and wants merged. */
  async #commitPending(thread: Thread): Promise<void> {
    if (thread.worktreePath === undefined) return;
    const wt = this.#git(thread.worktreePath);
    if (!(await wt.isRepo()) || (await wt.status()).dirty === 0) return;
    await wt.run(["add", "-A"]);
    await wt.run([...(await this.#identity(wt)), ...NO_SIGN, "commit", "-q", "-m", `tide: ${thread.title}`]);
  }

  async #identity(git: Git): Promise<string[]> {
    const email = await git.tryRun(["config", "user.email"]);
    return email.code === 0 && email.stdout.trim() !== "" ? [] : FALLBACK_IDENTITY;
  }

  // ---- local merge ----

  async #local(project: Project, thread: Thread, strategy: MergeStrategy): Promise<MergeResult> {
    const base = thread.baseBranch;
    const head = thread.branch;
    if (base === undefined || head === undefined) return { outcome: "error", error: "thread has no branch/base branch to merge" };
    const root = this.#git(project.rootPath);
    const baseRef = `refs/heads/${base}`;
    const baseSha = await root.revParse(baseRef);
    if (baseSha === undefined) return { outcome: "error", error: `base branch ${base} does not exist` };
    const headSha = await root.revParse(`refs/heads/${head}`);
    if (headSha === undefined) return { outcome: "error", error: `branch ${head} does not exist` };
    if ((await root.tryRun(["merge-base", "--is-ancestor", headSha, baseSha])).code === 0) {
      return { outcome: "merged", sha: baseSha, note: `${base} already contains ${head}` };
    }

    const tmp = this.tempPath(thread.id);
    await this.#dropTemp(root, tmp);
    await mkdir(join(tmp, ".."), { recursive: true });
    await root.run(["worktree", "add", "--detach", tmp, baseSha]);
    try {
      const work = this.#git(tmp);
      const result = await this.#apply(work, strategy, { base, head, headSha, title: thread.title });
      if (result.outcome !== "merged" || result.sha === undefined) return result;
      if (result.sha === baseSha) return { outcome: "merged", sha: baseSha, note: `${base} already contains ${head}` };
      const note = await this.#moveBase(root, base, baseSha, result.sha);
      return { outcome: "merged", sha: result.sha, ...(note !== undefined ? { note } : {}) };
    } finally {
      await this.#dropTemp(root, tmp);
    }
  }

  /** Runs the strategy inside the scratch worktree; `sha` is the commit the base should move to. */
  async #apply(
    work: Git,
    strategy: MergeStrategy,
    names: { base: string; head: string; headSha: string; title: string },
  ): Promise<MergeResult> {
    const id = [...(await this.#identity(work)), ...NO_SIGN];
    if (strategy === "merge") {
      const r = await work.tryRun([...id, "merge", "--no-ff", "--no-edit", "-m", `Merge ${names.head} into ${names.base}`, names.headSha]);
      if (r.code !== 0) return this.#failed(work, r.stderr || r.stdout, ["merge", "--abort"]);
    } else if (strategy === "squash") {
      const r = await work.tryRun([...id, "merge", "--squash", names.headSha]);
      if (r.code !== 0) return this.#failed(work, r.stderr || r.stdout, ["reset", "--hard"]);
      // nothing staged: the base already has every change the branch carries
      if ((await work.tryRun(["diff", "--cached", "--quiet"])).code !== 0) {
        await work.run([...id, "commit", "-q", "-m", names.title]);
      }
    } else {
      await work.run(["checkout", "-q", "--detach", names.headSha]);
      const onto = (await work.revParse(`refs/heads/${names.base}`)) ?? names.base;
      const r = await work.tryRun([...id, "rebase", onto]);
      if (r.code !== 0) return this.#failed(work, r.stderr || r.stdout, ["rebase", "--abort"]);
    }
    const sha = await work.revParse("HEAD");
    if (sha === undefined) return { outcome: "error", error: "merge produced no commit" };
    return { outcome: "merged", sha };
  }

  async #failed(work: Git, stderr: string, abort: string[]): Promise<MergeResult> {
    const conflicted = await work.tryRun(["diff", "--name-only", "--diff-filter=U"]);
    const files = conflicted.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    await work.tryRun(abort);
    if (files.length > 0) return { outcome: "conflicted", files };
    return { outcome: "error", error: stderr.trim().split("\n")[0] ?? "merge failed" };
  }

  /**
   * Moves the base branch to `to`. A checkout that has the base branch checked out (usually the
   * project root) is fast-forwarded when it is clean; when it is dirty its files are left alone
   * and only the ref moves, which the returned note explains.
   */
  async #moveBase(root: Git, base: string, from: string, to: string): Promise<string | undefined> {
    const checkout = (await root.worktreeList()).find((w) => w.branch === base);
    if (checkout !== undefined) {
      const git = root.at(checkout.path);
      if ((await git.status()).dirty === 0) {
        await git.run(["merge", "-q", "--ff-only", to]);
        return undefined;
      }
    }
    // compare-and-swap: refuses if someone moved the base since the merge started
    await root.run(["update-ref", `refs/heads/${base}`, to, from]);
    if (checkout === undefined) return undefined;
    return (
      `${checkout.path} has uncommitted changes, so only ${base} moved: its files are still at ${from.slice(0, 8)}. ` +
      `Once your changes are safe, sync it with: git -C ${checkout.path} read-tree -m -u ${from.slice(0, 8)} ${to.slice(0, 8)}`
    );
  }

  async #dropTemp(root: Git, tmp: string): Promise<void> {
    await root.tryRun(["worktree", "remove", "--force", tmp]);
    await rm(tmp, { recursive: true, force: true });
    await root.tryRun(["worktree", "prune"]);
  }

  // ---- via GitHub ----

  async #viaPr(project: Project, thread: Thread, strategy: MergeStrategy, deleteBranch: boolean): Promise<MergeResult> {
    const pr = thread.pr;
    const prMerge = this.#gh.prMerge?.bind(this.#gh);
    if (pr === undefined || prMerge === undefined) return { outcome: "error", error: "no pull request to merge" };
    // the PR must carry what the worktree has (committed just above)
    if (thread.worktreePath !== undefined && thread.branch !== undefined) {
      const wt = this.#git(thread.worktreePath);
      if (await wt.hasRemote()) await wt.push(thread.branch);
    }
    let failure: string | undefined;
    try {
      await prMerge(project.rootPath, pr.number, { strategy, ...(deleteBranch ? { deleteBranch: true } : {}) });
    } catch (err) {
      // gh can fail *after* merging (e.g. deleting a branch checked out in a worktree): the poll decides
      failure = message(err);
      this.#log("[vcs] gh pr merge reported a failure; checking the PR state", failure);
    }
    for (let attempt = 0; attempt < this.#pollAttempts; attempt++) {
      const view = await this.#gh.prView(project.rootPath, String(pr.number));
      if (view?.state === "merged") {
        return { outcome: "merged", pr: { url: view.url, number: view.number, state: "merged", updatedAt: this.#now() } };
      }
      if (view?.state === "closed") return { outcome: "error", error: `pull request #${pr.number} was closed without merging` };
      if (failure !== undefined && attempt > 0) break;
      await this.#delay(this.#pollIntervalMs);
    }
    return { outcome: "error", error: `pull request #${pr.number} is not merged${failure !== undefined ? `: ${failure}` : " yet"}` };
  }
}
