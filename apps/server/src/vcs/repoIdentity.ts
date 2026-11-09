import { normalizeRemoteUrl, type RepoIdentity } from "@tide/contracts";
import { Git } from "./git.ts";

/** Repo identity from `origin`; undefined when the root is not a repo or has no usable remote. */
export async function detectRepoIdentity(rootPath: string, git: Git = new Git(rootPath)): Promise<RepoIdentity | undefined> {
  const remote = await git.tryRun(["remote", "get-url", "origin"]);
  if (remote.code !== 0) return undefined;
  const cloneUrl = remote.stdout.trim();
  const remoteUrl = normalizeRemoteUrl(cloneUrl);
  if (remoteUrl === undefined) return undefined;

  let defaultBranch: string | undefined;
  const head = await git.tryRun(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    if (name !== "") defaultBranch = name;
  }
  if (defaultBranch === undefined) {
    for (const candidate of ["main", "master"]) {
      if ((await git.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])).code === 0) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  defaultBranch ??= await git.currentBranch();
  if (defaultBranch === undefined) return undefined;

  const sha = await git.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  const headSha = sha.code === 0 && sha.stdout.trim() !== "" ? sha.stdout.trim() : undefined;
  return { remoteUrl, cloneUrl, defaultBranch, ...(headSha !== undefined ? { headSha } : {}), detectedAt: Date.now() };
}
