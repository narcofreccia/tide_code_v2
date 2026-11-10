import type { Git } from "./git.ts";

/**
 * The tree `git merge --squash <head>` produces on `base` (no conflicts), or undefined. Uses
 * `git merge-tree --write-tree` (git >= 2.38); older git falls back to the common case where the
 * thread branch contains `base`, whose merge result is the branch tip's own tree.
 */
async function mergedTree(git: Git, base: string, head: string): Promise<string | undefined> {
  const r = await git.tryRun(["merge-tree", "--write-tree", base, head]);
  if (r.code === 0) return r.stdout.split("\n")[0]?.trim() || undefined;
  if (r.code === 1) return undefined; // conflicts: a squash of this pair never committed
  if ((await git.tryRun(["merge-base", "--is-ancestor", base, head])).code !== 0) return undefined;
  const tree = await git.tryRun(["rev-parse", "--verify", "--quiet", `${head}^{tree}`]);
  return tree.code === 0 ? tree.stdout.trim() || undefined : undefined;
}

/**
 * R19 L3: the squash commit a merge-back landed on the base before the process died, or undefined.
 *
 * `MergeBack` squashes in a scratch worktree detached at the base head it read (`recordedBase`)
 * and then moves the base to the result by fast-forward or compare-and-swap, so a landed squash
 * is the first first-parent commit after `recordedBase`, it has exactly that one parent, and its
 * tree is exactly the tree of squashing the thread tip onto `recordedBase`. Commits other people
 * added on top later do not matter; an unrelated commit in that slot has another tree.
 */
export async function findLandedSquash(git: Git, recordedBase: string, baseHead: string, threadTip: string): Promise<string | undefined> {
  if (baseHead === recordedBase) return undefined;
  if ((await git.tryRun(["merge-base", "--is-ancestor", recordedBase, baseHead])).code !== 0) return undefined;
  const list = await git.tryRun(["rev-list", "--first-parent", "--reverse", `${recordedBase}..${baseHead}`]);
  const candidate = list.code === 0 ? list.stdout.split("\n")[0]?.trim() : undefined;
  if (candidate === undefined || candidate === "") return undefined;
  const parents = (await git.tryRun(["rev-list", "--parents", "-n", "1", candidate])).stdout.trim().split(/\s+/);
  if (parents.length !== 2 || parents[1] !== recordedBase) return undefined;
  const tree = await git.tryRun(["rev-parse", "--verify", "--quiet", `${candidate}^{tree}`]);
  const expected = await mergedTree(git, recordedBase, threadTip);
  return tree.code === 0 && expected !== undefined && tree.stdout.trim() === expected ? candidate : undefined;
}
