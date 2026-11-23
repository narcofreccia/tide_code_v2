import type { Git } from "./git.ts";

/**
 * R17 B4: one repository checked out on several machines meets at `origin`. Thread branches are
 * pushed there for review elsewhere, the base is fast-forwarded from it before a merge back and,
 * only when the user asks for it, pushed to it afterwards. Nothing here ever force-pushes or rewrites a branch: anything that is
 * not a fast-forward is reported, in words, and left to the user.
 */

/** fetch / push may cross a slow link; local git keeps its 120 s default */
export const NETWORK_TIMEOUT_MS = 600_000;

/** the fetch before a merge back: an unreachable origin must not hold the merge for minutes */
export const SYNC_FETCH_TIMEOUT_MS = 15_000;

const net = (git: Git): Git => git.withTimeout(NETWORK_TIMEOUT_MS);

function firstLine(text: string, fallback: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("hint:"));
  const error = lines.find((l) => l.startsWith("error:") || l.startsWith("fatal:") || l.startsWith("!"));
  return (error ?? lines[0] ?? fallback).replace(/^(error|fatal):\s*/, "");
}

/** `[rejected] … (non-fast-forward)` / `(fetch first)`: the remote has commits this side lacks. */
function rejected(stderr: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first/.test(stderr);
}

export async function hasOrigin(git: Git): Promise<boolean> {
  return (await git.tryRun(["remote", "get-url", "origin"])).code === 0;
}

export type PushResult = { ok: true; sha: string; remoteBranch: string } | { ok: false; error: string };

/** `git push -u origin <branch>`. A rejection (origin moved) is reported, never forced. */
export async function pushThreadBranch(git: Git, branch: string): Promise<PushResult> {
  const sha = await git.revParse(`refs/heads/${branch}`);
  if (sha === undefined) return { ok: false, error: `branch ${branch} does not exist` };
  const r = await net(git).tryRun(["push", "-u", "origin", branch]);
  if (r.code === 0) return { ok: true, sha, remoteBranch: branch };
  if (rejected(r.stderr)) return { ok: false, error: `origin/${branch} has commits this machine does not have; not force-pushing` };
  return { ok: false, error: firstLine(r.stderr, "git push failed") };
}

export type FetchResult = { ok: true; found: boolean } | { ok: false; error: string };

/**
 * Updates `refs/remotes/origin/<base>` (explicit refspec: works without a tracking config).
 * A timeout kills git and comes back as a failed run (`tryRun` never throws, `timedOut` set), so it
 * reads as `ok: false` like any other unreachable origin.
 */
export async function fetchBase(git: Git, base: string, timeoutMs = NETWORK_TIMEOUT_MS): Promise<FetchResult> {
  const r = await git.withTimeout(timeoutMs).tryRun(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  if (r.code === 0) return { ok: true, found: true };
  if (/couldn't find remote ref/i.test(r.stderr)) return { ok: true, found: false };
  const noAnswer = `no answer from origin within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
  return { ok: false, error: r.timedOut === true ? noAnswer : firstLine(r.stderr, noAnswer) };
}

/** `<base>` against `origin/<base>` as last fetched; undefined when either side is missing. */
export async function baseAheadBehind(git: Git, base: string): Promise<{ ahead: number; behind: number } | undefined> {
  const r = await git.tryRun(["rev-list", "--left-right", "--count", `refs/heads/${base}...refs/remotes/origin/${base}`]);
  if (r.code !== 0) return undefined;
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  if (ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) return undefined;
  return { ahead, behind };
}

export type FastForward =
  | { outcome: "up-to-date" | "ahead" | "no-remote-branch"; sha?: string }
  | { outcome: "fast-forwarded"; sha: string; commits: number }
  | { outcome: "dirty"; path: string; behind: number }
  | { outcome: "diverged"; ahead: number; behind: number }
  | { outcome: "missing" };

/**
 * Moves `<base>` to the already-fetched `origin/<base>` when that is a fast-forward. Like the
 * merge-back's base move: a checkout that has `<base>` checked out is fast-forwarded only when it
 * is clean (`merge --ff-only`), a dirty one is refused; with no checkout only the ref moves
 * (compare-and-swap `update-ref`).
 */
export async function fastForwardBase(git: Git, base: string): Promise<FastForward> {
  const local = await git.revParse(`refs/heads/${base}`);
  if (local === undefined) return { outcome: "missing" };
  const remote = await git.revParse(`refs/remotes/origin/${base}`);
  if (remote === undefined) return { outcome: "no-remote-branch", sha: local };
  if (remote === local) return { outcome: "up-to-date", sha: local };
  const counts = (await baseAheadBehind(git, base)) ?? { ahead: 0, behind: 0 };
  if (counts.behind === 0) return { outcome: "ahead", sha: local };
  if (counts.ahead > 0) return { outcome: "diverged", ahead: counts.ahead, behind: counts.behind };
  const checkout = (await git.worktreeList()).find((w) => w.branch === base);
  if (checkout !== undefined) {
    const at = git.at(checkout.path);
    if ((await at.status()).dirty > 0) return { outcome: "dirty", path: checkout.path, behind: counts.behind };
    await at.run(["merge", "-q", "--ff-only", `refs/remotes/origin/${base}`]);
  } else {
    await git.run(["update-ref", `refs/heads/${base}`, remote, local]);
  }
  return { outcome: "fast-forwarded", sha: remote, commits: counts.behind };
}

export type SyncResult = { ok: true; note?: string; warning?: string } | { ok: false; note: string };

/**
 * Before a merge back: fetch `origin/<base>` (short timeout) and fast-forward the local base to
 * it, so a merge never lands on a stale base. When origin cannot be reached the merge goes ahead
 * on the local base with a `warning`; a dirty base checkout that is behind, or a diverged base,
 * refuse (`ok: false`) with a sentence the user can act on, because merging there would be wrong.
 */
export async function syncBase(git: Git, base: string): Promise<SyncResult> {
  const fetched = await fetchBase(git, base, SYNC_FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    return { ok: true, warning: `could not check ${base} against origin (${fetched.error}); merging into the local ${base}` };
  }
  if (!fetched.found) return { ok: true };
  const ff = await fastForwardBase(git, base);
  switch (ff.outcome) {
    case "fast-forwarded":
      return { ok: true, note: `${base} fast-forwarded to origin (${ff.commits} new commit${ff.commits === 1 ? "" : "s"})` };
    case "dirty":
      return { ok: false, note: `${base} is ${ff.behind} commit${ff.behind === 1 ? "" : "s"} behind origin and ${ff.path} has uncommitted changes; commit or stash them and pull first` };
    case "diverged":
      return { ok: false, note: `${base} has diverged from origin/${base} (${ff.ahead} local, ${ff.behind} remote commits); reconcile them and retry` };
    default:
      return { ok: true };
  }
}

export type PushBaseResult = { ok: true } | { ok: false; error: string };

/** After a merge back: `git push origin <base>`; a rejection means origin moved meanwhile. */
export async function pushBase(git: Git, base: string): Promise<PushBaseResult> {
  const r = await net(git).tryRun(["push", "origin", `refs/heads/${base}:refs/heads/${base}`]);
  if (r.code === 0) return { ok: true };
  if (rejected(r.stderr)) return { ok: false, error: `${base} moved on origin, pull first` };
  return { ok: false, error: firstLine(r.stderr, "git push failed") };
}
